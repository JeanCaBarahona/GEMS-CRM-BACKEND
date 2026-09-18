const mongoose = require('mongoose');

/**
 * Plugin Mongoose que agrega un historial de acciones (`history`) al documento:
 * quién hizo qué y cuándo. Lo usan Task y Activity; la lógica para detectar
 * cambios al editar vive en services/historyService.js.
 */
module.exports = function historyPlugin(schema) {
  schema.add({
    history: [{
      // created | updated | moved | comment_added | comment_edited | comment_deleted | attachment_added
      // Las entradas anteriores a este campo no lo tienen y se leen como 'updated'.
      action: {
        type: String,
        default: 'updated'
      },
      field: String,
      oldValue: mongoose.Schema.Types.Mixed,
      newValue: mongoose.Schema.Types.Mixed,
      changedBy: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User'
      },
      changedAt: {
        type: Date,
        default: Date.now
      }
    }]
  });

  schema.methods.logChange = function(field, oldValue, newValue, userId, action = 'updated') {
    this.history.push({
      action,
      field,
      oldValue,
      newValue,
      changedBy: userId
    });
  };

  schema.methods.logAction = function(action, userId, { oldValue, newValue } = {}) {
    this.history.push({
      action,
      oldValue,
      newValue,
      changedBy: userId
    });
  };
};
