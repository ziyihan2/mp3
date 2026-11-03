
/*
 * API Routes
 * Handles HTTP requests for users and tasks.
 */

var U = require('../models/user');
var T = require('../models/tasks');
var mg = require('mongoose');

function fail(code, msg) {
    var err = new Error(msg);
    err.status = code;
    throw err;
}

function ok(res, code, msg, d) {
    return res.status(code).json({message: msg, data: d});
}

function errRes(res, err, msg, cast = 400) {
    var code = err.status;
    if (!code) {
        if (err.name === 'ValidationError' || err.code === 11000 || err.name === 'CastError') {
            code = err.name === 'CastError' ? cast : 400;
        } else {
            code = 500;
        }
    }
    return res.status(code).json({message: err.status ? err.message :code === 400 ? 'Invalid request information' : msg, data: null});
}

// Parse JSON query parameters
function parse(v, nm, def) {
    if (v === undefined) return def;
    try {
        if (typeof v !== 'string') throw new Error();
        return JSON.parse(v);
    } catch (err) {
        fail(400, 'Invalid ' + nm + ' parameter');
    }
}

// Read and validate GET query parameters
function getOpts(req, defLim) {
    var w = parse(req.query.where, 'where', {});
    var srt = parse(req.query.sort, 'sort', {});
    var sel = parse(req.query.select, 'select', {});
    var sk = parse(req.query.skip, 'skip', 0);
    var lim = parse(req.query.limit, 'limit', defLim);
    var cnt = parse(req.query.count, 'count', false);

    function isObj(v) {
        return v !== null && typeof v === 'object' && !Array.isArray(v);
    }

    if (!isObj(w) || !isObj(srt) || !isObj(sel) || !Object.values(srt).every(v => v === 1 || v === -1) || !Object.values(sel).every(v => v === 1 || v === 0) ||
        !Number.isSafeInteger(sk) || sk < 0 || (lim !== undefined && (!Number.isSafeInteger(lim) || lim < 0)) || typeof cnt !== 'boolean') {
        fail(400, 'Invalid query parameters');
    }

    return {where:w, sort:srt, select:sel, skip:sk, limit:lim, count:cnt};
}

module.exports = function (r) {

    // GET all users
    r.get('/users', async function (req, res) {
        try {
            var opt = getOpts(req);
            if (opt.count) {
                var cnt = await U.countDocuments(opt.where);
                return ok(res, 200, 'OK', cnt);
            }

            var q = U.find(opt.where).sort(opt.sort).select(opt.select).skip(opt.skip);
            if (opt.limit !== undefined) {
                q = q.limit(opt.limit);
            }

            var us = await q;
            return ok(res, 200, 'OK', us);

        } catch (err) {
            return errRes(res, err, 'Failed to get users');
        }
    });

    // POST: Create a new user
    r.post('/users', async function (req, res) {
        var ss;

        try {
            ss = await mg.startSession();
            var newU;
            await ss.withTransaction(async function () {
                var nm = req.body.name;
                var mail = req.body.email;
                var pids = req.body.pendingTasks === undefined ? [] : req.body.pendingTasks;

                // Validate user information
                if (typeof nm !== 'string' || !nm.trim() || typeof mail !== 'string' || !mail.trim()) {
                    fail(400, 'Name and email are required');
                }

                // Validate pendingTasks
                if (!Array.isArray(pids) || pids.some(id => typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id))) {
                    fail(400, 'Invalid pendingTasks');
                }
                pids = pids.map(id => id.toLowerCase());
                if (new Set(pids).size !== pids.length) fail(400, 'Duplicate task IDs');
                
                // Check duplicate email
                var exist = await U.findOne({email: mail}).session(ss);
                if (exist) fail(400, 'Email already exists');

                // Validate referenced tasks
                var ts = await T.find({_id: { $in: pids }}).session(ss);
                if (ts.some(t => t.completed)) (400, 'Completed tasks cannot be pending');
                if (ts.length !== pids.length) fail(404, 'Task not found');
        
                // Create user
                var us = await U.create([{
                    name: nm,
                    email: mail,
                    pendingTasks: pids
                }], { session: ss });

                newU = us[0];
                var uid = newU._id.toString();

                // Find previous owners
                var prev = ts.map(t => t.assignedUser).filter(id => id && id !== uid);

                // Remove tasks from previous users
                if (prev.length > 0) {
                    await U.updateMany(
                        { _id: { $in: prev } },
                        { $pull: { pendingTasks: { $in: pids } } },
                        { session: ss }
                    );
                }

                // Assign tasks to new user
                if (pids.length > 0) {
                    await T.updateMany(
                        { _id: { $in: pids } },
                        {
                            $set: {
                                assignedUser: uid,
                                assignedUserName: nm
                            }
                        },
                        { session: ss }
                    );
                }
            });
            return ok(res, 201, 'User created successfully', newU);

        } catch (err) {
            return errRes(res, err, 'Failed to create user');
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    // GET: Find a user by ID
    r.get('/users/:id', async function (req, res) {
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'User not found');
            var sel = parse(req.query.select, 'select', {});
            if (sel === null || typeof sel !== 'object' || Array.isArray(sel) || !Object.values(sel).every(v => v === 1 || v === 0)) {
                fail(400, 'Invalid select parameter');
            }
            var u = await U.findById(req.params.id).select(sel);
            if (!u) fail(404, 'User not found');
            return ok(res, 200, 'OK', u);

        } catch (err) {
            return errRes(res, err, 'Failed to get user', 404);
        }
    });

    // PUT: Update a user
    r.put('/users/:id', async function (req, res) {
        var ss;
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'User not found');
            ss = await mg.startSession();
            var upU;

            await ss.withTransaction(async function () {
                var u = await U.findById(req.params.id).session(ss);
                if (!u) fail(404, 'User not found');
                var nm = req.body.name;
                var mail = req.body.email;
                var pids = req.body.pendingTasks === undefined ? [] : req.body.pendingTasks;

                // Validate user information
                if (typeof nm !== 'string' || !nm.trim() || typeof mail !== 'string' || !mail.trim()) {
                    fail(400, 'Name and email are required');
                }

                if (!Array.isArray(pids) || pids.some(id => typeof id !== 'string' || !/^[0-9a-fA-F]{24}$/.test(id))) {
                    fail(400, 'Invalid pendingTasks');
                }

                pids = pids.map(id => id.toLowerCase());
                if (new Set(pids).size !== pids.length) fail(400, 'Duplicate task IDs');
                
                // Check duplicate email
                var exist = await U.findOne({email: mail, _id: { $ne: u._id }}).session(ss);
                if (exist) fail(400, 'Email already exists');
                
                // Validate referenced tasks
                var ts = await T.find({_id: { $in: pids }}).session(ss);
                if (ts.some(t => t.completed)) fail(400, 'Completed tasks cannot be pending');
                if (ts.length !== pids.length) fail(404, 'Task not found');
                var uid = u._id.toString();
                var ids = new Set(pids);

                // Tasks removed from pending list
                var gone = u.pendingTasks.filter(id => !ids.has(id.toLowerCase()));

                // Find previous owners
                var prev = ts.map(t => t.assignedUser).filter(id => id && id !== uid);

                // Remove transferred tasks
                if (prev.length > 0) {
                    await U.updateMany(
                        { _id: { $in: prev } },
                        { $pull: { pendingTasks: { $in: pids } } },
                        { session: ss }
                    );
                }

                // Unassign removed tasks
                await T.updateMany(
                    {
                        _id: { $in: gone },
                        assignedUser: uid
                    },
                    {
                        $set: {
                            assignedUser: "",
                            assignedUserName: "unassigned"
                        }
                    },
                    { session: ss }
                );

                // Assign requested pending tasks
                await T.updateMany(
                    { _id: { $in: pids } },
                    {
                        $set: {
                            assignedUser: uid,
                            assignedUserName: nm
                        }
                    },
                    { session: ss }
                );

                // Update names on all assigned tasks
                await T.updateMany(
                    { assignedUser: uid },
                    { $set: { assignedUserName: nm } },
                    { session: ss }
                );

                // Update user
                u.name = nm;
                u.email = mail;
                u.pendingTasks = pids;
                upU = await u.save({ session: ss });
            });
            return ok(res, 200, 'User updated successfully', upU);

        } catch (err) {
            return errRes(res, err, 'Failed to update user');
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    // DELETE: Delete a user
    r.delete('/users/:id', async function (req, res) {
        var ss;
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'User not found');
            ss = await mg.startSession();
            await ss.withTransaction(async function () {
                var u = await U.findById(req.params.id).session(ss);
                if (!u) fail(404, 'User not found');
                var uid = u._id.toString();

                // Unassign all tasks
                await T.updateMany(
                    { assignedUser: uid },
                    {
                        $set: {
                            assignedUser: "",
                            assignedUserName: "unassigned"
                        }
                    },
                    { session: ss }
                );

                // Delete user
                await U.deleteOne(
                    { _id: u._id },
                    { session: ss }
                );
            });

            res.status(204).send();

        } catch (err) {
            return errRes(res, err, 'Failed to delete user', 500);
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    // GET all tasks
    r.get('/tasks', async function (req, res) {
        try {
            var opt = getOpts(req, 100);
            if (opt.count) {
                var cnt = await T.countDocuments(opt.where);
                return ok(res, 200, 'OK', cnt);
            }
            var ts = await T.find(opt.where).sort(opt.sort).select(opt.select).skip(opt.skip).limit(opt.limit);
            return ok(res, 200, 'OK', ts);

        } catch (err) {
            return errRes(res, err, 'Failed to get tasks');
        }
    });

    // POST: Create a new task
    r.post('/tasks', async function (req, res) {
        var ss;
        try {
            var nm = req.body.name;
            var desc = req.body.description === undefined ? "" : req.body.description;
            var due = req.body.deadline;
            var done = req.body.completed === undefined ? false : req.body.completed;
            var aid = req.body.assignedUser === undefined ? "" : req.body.assignedUser;
            var aNm = req.body.assignedUserName;

            // Validate task information
            if (typeof nm !== 'string' || !nm.trim() || typeof due !== 'string' || !due.trim() || isNaN(new Date(due).getTime())) {
                fail(400, 'Invalid name or deadline');
            }

            if (typeof desc !== 'string' || typeof done !== 'boolean' || typeof aid !== 'string' || (aNm !== undefined && typeof aNm !== 'string')) {
                fail(400, 'Invalid task information');
            }

            // Validate assigned user ID
            if (aid !== "" && !/^[0-9a-fA-F]{24}$/.test(aid)) {
                fail(400, 'Invalid assignedUser ID');
            }

            if (aid === "" && aNm !== undefined && aNm !== "unassigned") {
                fail(400, 'Invalid assignedUserName');
            }

            ss = await mg.startSession();
            var newT;

            await ss.withTransaction(async function () {
                // Check assigned user
                if (aid !== "") {
                    var u = await U.findById(aid).session(ss);
                    if (!u) fail(404, 'User not found');
                    
                    if (aNm !== undefined && aNm !== u.name) {
                        fail(400, 'Assigned username does not match');
                    }
                    aid = u._id.toString();
                    aNm = u.name;
                } else {
                    aNm = "unassigned";
                }

                // Create task
                var ts = await T.create([{
                    name: nm,
                    description: desc,
                    deadline: new Date(due),
                    completed: done,
                    assignedUser: aid,
                    assignedUserName: aNm
                }], { session: ss });

                newT = ts[0];

                // Update user's pendingTasks
                if (aid !== "" && !done) {
                    await U.updateOne(
                        { _id: aid },
                        {
                            $addToSet: {
                                pendingTasks: newT._id.toString()
                            }
                        },
                        { session: ss }
                    );
                }
            });

            return ok(res, 201, 'Task created successfully', newT);

        } catch (err) {
            return errRes(res, err, 'Failed to create task');
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    // GET: Find a task by ID
    r.get('/tasks/:id', async function (req, res) {
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'Task not found');
            var sel = parse(req.query.select, 'select', {});
            if (sel === null || typeof sel !== 'object' || Array.isArray(sel) || !Object.values(sel).every(v => v === 1 || v === 0)) {
                fail(400, 'Invalid select parameter');
            }

            var t = await T.findById(req.params.id).select(sel);
            if (!t) fail(404, 'Task not found');
            return ok(res, 200, 'OK', t);

        } catch (err) {
            return errRes(res, err, 'Failed to get task', 404);
        }
    });

    // PUT: Update a task
    r.put('/tasks/:id', async function (req, res) {
        var ss;
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'Task not found');
            ss = await mg.startSession();
            var upT;
            await ss.withTransaction(async function () {
                var t = await T.findById(req.params.id).session(ss);
                if (!t) fail(404, 'Task not found');
                var nm = req.body.name;
                var desc = req.body.description === undefined ? "" : req.body.description;
                var due = req.body.deadline;
                var done = req.body.completed === undefined ? false : req.body.completed;
                var aid = req.body.assignedUser === undefined ? "" : req.body.assignedUser;
                var aNm = req.body.assignedUserName;

                // Validate required fields
                if (typeof nm !== 'string' || !nm.trim() || typeof due !== 'string' || !due.trim() || isNaN(new Date(due).getTime())) {
                    fail(400, 'Invalid name or deadline');
                }

                // Validate optional fields
                if (typeof desc !== 'string' || typeof done !== 'boolean' || typeof aid !== 'string') {
                    fail(400, 'Invalid task information');
                }

                if (aNm !== undefined && typeof aNm !== 'string') {
                    fail(400, 'Invalid assignedUserName');
                }
                // Check assigned user ID format
                if (aid !== "" && !/^[0-9a-fA-F]{24}$/.test(aid)) {
                    fail(400, 'Invalid assignedUser ID');
                }

                // Validate assigned user
                if (aid === "") {
                    if (aNm !== undefined && aNm !== "unassigned") fail(400, 'Invalid assignedUserName');
                    aNm = "unassigned";
                } else {
                    var u = await U.findById(aid).session(ss);
                    if (!u) fail(404, 'User not found');
                    if (aNm !== undefined && aNm !== u.name) {
                        fail(400, 'Assigned username does not match');
                    }
                    aid = u._id.toString();
                    aNm = u.name;
                }

                var tid = t._id.toString();

                // Remove task from previous pending lists
                await U.updateMany(
                    { pendingTasks: tid },
                    { $pull: { pendingTasks: tid } },
                    { session: ss }
                );

                // Add task to new user if not completed
                if (aid !== "" && !done) {
                    await U.updateOne(
                        { _id: aid },
                        { $addToSet: { pendingTasks: tid } },
                        { session: ss }
                    );
                }

                // Update task
                t.name = nm;
                t.description = desc;
                t.deadline = new Date(due);
                t.completed = done;
                t.assignedUser = aid;
                t.assignedUserName = aNm;

                upT = await t.save({ session: ss });
            });

            return ok(res, 200, 'Task updated successfully', upT);

        } catch (err) {
            return errRes(res, err, 'Failed to update task');
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    // DELETE: Delete a task
    r.delete('/tasks/:id', async function (req, res) {
        var ss;
        try {
            if (!/^[0-9a-fA-F]{24}$/.test(req.params.id)) fail(404, 'Task not found');
            ss = await mg.startSession();
            await ss.withTransaction(async function () {
                var t = await T.findById(req.params.id).session(ss);
                if (!t) fail(404, 'Task not found');
                var tid = t._id.toString();

                // Remove task from user's pendingTasks
                await U.updateMany(
                    { pendingTasks: tid },
                    { $pull: { pendingTasks: tid } },
                    { session: ss }
                );

                // Delete task
                await T.deleteOne(
                    { _id: t._id },
                    { session: ss }
                );
            });
            res.status(204).send();

        } catch (err) {
            return errRes(res, err, 'Failed to delete task', 500);
        } finally {
            if (ss) {
                await ss.endSession();
            }
        }
    });

    return r;
};
