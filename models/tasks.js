
/*
 * Task Model
 * Each task contains:
 * - name: The task's name (required).
 * - description: A description of the task.
 * - deadline: The task's deadline (required).
 * - completed: Whether the task is completed.
 * - assignedUser: The ID of the user assigned to the task.
 * - assignedUserName: The name of the assigned user.
 * - dateCreated: The date when the task was created, set automatically.
 */

// Load required packages
var mongoose = require('mongoose');

// Define our task schema
var TaskSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    description: {
        type: String,
        default: ""
    },
    deadline: {
        type: Date,
        required: true
    },
    completed: {
        type: Boolean,
        default: false
    },
    assignedUser: {
        type: String,
        default: ""
    },
    assignedUserName: {
        type: String,
        default: "unassigned"
    },
    dateCreated: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

// Export the Mongoose model
module.exports = mongoose.model('Task', TaskSchema);
