
/*
 * User Model
 * Each user contains:
 * - name: The user's name (required).
 * - email: The user's email address (required and unique).
 * - pendingTasks: An array of IDs of unfinished tasks assigned to the user.
 * - dateCreated: The date when the user was created, set automatically.
 */


// Load required packages
var mongoose = require('mongoose');

// Define our user schema
var UserSchema = new mongoose.Schema({
    name: {
        type: String,
        required: true
    },
    email: {
        type: String,
        required: true,
        unique: true
    },
    pendingTasks: {
        type: [String],
        default: []
    },
    dateCreated: {
        type: Date,
        default: Date.now,
        immutable: true
    }
});

// Export the Mongoose model
module.exports = mongoose.model('User', UserSchema);
