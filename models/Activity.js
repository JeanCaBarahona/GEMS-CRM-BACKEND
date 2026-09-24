const mongoose = require('mongoose');
const historyPlugin = require('./plugins/history');

const ActivitySchema = new mongoose.Schema({
  organizationId: { type: mongoose.Schema.Types.ObjectId, ref: 'Organization', required: true, index: true },
  title: { type: String, required: true },
  description: String,
  date: Date,
  status: { 
    type: String, 
    enum: ['pending', 'in-progress', 'completed', 'cancelled', 'overdue'], 
    default: 'pending' 
  },
  clientId: { type: mongoose.Schema.Types.ObjectId, ref: 'Client' },
  // Proyecto del cliente en el que se trabajó (subdocumento de Client.projects)
  projectId: { type: mongoose.Schema.Types.ObjectId, default: null, index: true },
  // El formulario ya enviaba el tipo, pero sin este campo Mongoose lo descartaba.
  type: {
    type: String,
    enum: ['task', 'bug', 'feature', 'user-story'],
    default: 'task'
  },
  // Feature (otra Activity de type 'feature' del mismo proyecto) a la que
  // pertenece esta tarea — arma la cascada Proyecto → Feature → Tarea del Backlog.
  featureId: { type: mongoose.Schema.Types.ObjectId, ref: 'Activity', default: null, index: true },
  acceptanceCriteria: { type: String, default: '' },
  environment: {
    type: String,
    enum: ['development', 'testing', 'production', null],
    default: null
  },
  attachments: [{
    name: String,
    url: String,
    mimetype: String,
    size: Number,
    uploadedBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    uploadedAt: { type: Date, default: Date.now }
  }],
  assignedTo: [{ type: mongoose.Schema.Types.ObjectId, ref: 'User' }], // Referencia a múltiples miembros del equipo
  priority: { 
    type: String, 
    enum: ['low', 'medium', 'high', 'urgent'], 
    default: 'medium' 
  },
  dueDate: { type: Date },
  // Evitan reenviar el mismo recordatorio de vencimiento en cada corrida del cron.
  // Se resetean a false cuando dueDate cambia (ver PUT /:id).
  dueSoonNotified: { type: Boolean, default: false },
  overdueNotified: { type: Boolean, default: false },
  estimatedTime: { type: String }, // Ej: "2 horas", "30 minutos"
  taskId: { type: String }, // ✅ ID de la tarea del board asociada (para sincronización)
  // Vinculación con Casos y artículos de Wiki
  linkedCases: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Case' }],
  linkedWikiArticles: [{ type: mongoose.Schema.Types.ObjectId, ref: 'Wiki' }],
  completionPercentage: { type: Number, default: 0, min: 0, max: 100 },
  timeSpent: { type: Number, default: 0 }, // En segundos
  activeSessions: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    startTime: { type: Date, default: Date.now }
  }],
  comments: [{
    userId: { type: mongoose.Schema.Types.ObjectId, ref: 'User' },
    text: String,
    images: [{ url: String, name: String }],
    createdAt: { type: Date, default: Date.now }
  }],
  createdBy: { type: mongoose.Schema.Types.ObjectId, ref: 'User' }, // Quien creó la actividad
  createdAt: { type: Date, default: Date.now },
  updatedAt: { type: Date, default: Date.now }
});

// Historial de acciones (history, logChange, logAction)
ActivitySchema.plugin(historyPlugin);

// Middleware para actualizar updatedAt en cada modificación
ActivitySchema.pre('save', function(next) {
  this.updatedAt = new Date();
  next();
});

module.exports = mongoose.model('Activity', ActivitySchema);
