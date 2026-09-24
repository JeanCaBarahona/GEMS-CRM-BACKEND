const express = require('express');
const router = express.Router();
const Ticket = require('../models/Ticket');
const User = require('../models/User');
const Membership = require('../models/Membership');
const Organization = require('../models/Organization');
const { authenticateToken, requireRole } = require('../middleware/auth');
const { runWithTenant } = require('../services/tenantContext');
const multer = require('multer');
const path = require('path');
const fs = require('fs');

const {
  notifyTicketCreated,
  notifyStatusChanged,
  notifyNewComment
} = require('../services/emailService');

// ─── Upload de adjuntos de tickets ─────
const storage = multer.diskStorage({
  destination: function (req, file, cb) {
    const dir = 'uploads/tickets/';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    cb(null, dir);
  },
  filename: function (req, file, cb) {
    cb(null, 'ticket-' + Date.now() + '-' + Math.round(Math.random() * 1e9) + path.extname(file.originalname));
  }
});

const ALLOWED_MIMES = new Set([
  'image/jpeg', 'image/png', 'image/webp', 'image/gif',
  'application/pdf', 'application/zip',
  'application/msword', 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
  'application/vnd.ms-excel', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
  'text/plain'
]);
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    if (ALLOWED_MIMES.has(file.mimetype)) cb(null, true);
    else cb(new Error('Tipo de archivo no permitido'), false);
  }
});

const getPriorityText = (priority) => ({
  low: '🟢 Baja', medium: '🟡 Media', high: '🟠 Alta', urgent: '🔴 Urgente'
})[priority] || '🟡 Media';

// ───── PÚBLICAS ─────
// POST /api/tickets/public/:orgSlug  — formulario externo de soporte
// Resuelve la org por slug y crea el ticket dentro de su contexto.
router.post('/public/:orgSlug', upload.array('files', 5), async (req, res) => {
  try {
    const org = await Organization.findOne({ slug: req.params.orgSlug, status: 'active' });
    if (!org) {
      return res.status(404).json({ success: false, error: 'Organización no encontrada o inactiva' });
    }

    await runWithTenant(org._id, async () => {
      const { subject, description, category, priority, name, email, clientId, userId } = req.body;
      const attachments = (req.files || []).map(f => `/uploads/tickets/${f.filename}`);

      const ticket = new Ticket({
        organizationId: org._id, // explícito + plugin lo refuerza
        subject, description, category, priority, attachments,
        submittedBy: { name, email, clientId, userId }
      });

      // Auto-asignación: agente de soporte con menos tickets activos en esta org
      const supportMembers = await Membership.find({
        organization: org._id,
        role: 'support',
        status: 'active'
      }).populate('user');
      const supportAgents = supportMembers.map(m => m.user).filter(u => u && u.isActive);

      let assignedAgent = null;
      if (supportAgents.length > 0) {
        const loads = await Promise.all(supportAgents.map(async (agent) => {
          const count = await Ticket.countDocuments({
            organizationId: org._id,
            assignedTo: agent._id,
            status: { $in: ['new', 'open', 'waiting'] }
          });
          return { agent, count };
        }));
        loads.sort((a, b) => a.count - b.count);
        assignedAgent = loads[0].agent;
        ticket.assignedTo = assignedAgent._id;
        ticket.status = 'open';
      }

      await ticket.save();

      const populated = await Ticket.findOne({ _id: ticket._id, organizationId: org._id })
        .populate('assignedTo', 'name email avatar photo');

      notifyTicketCreated(populated || ticket, assignedAgent)
        .catch(e => console.error('[Email] notifyTicketCreated:', e.message));

      res.status(201).json({
        success: true,
        data: populated || ticket,
        message: 'Ticket creado exitosamente'
      });
    });
  } catch (error) {
    console.error('Error creating public ticket:', error);
    res.status(400).json({ success: false, error: error.message });
  }
});

// ───── AUTENTICADAS ─────
// (authenticateToken + requireOrganization ya viene del wall global en index.js,
//  los mantengo explícitos aquí también como defensa adicional)

router.get('/', authenticateToken, async (req, res) => {
  try {
    const { status, priority, category, assignedTo } = req.query;
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 15;
    const skip = (page - 1) * limit;

    const query = { organizationId: req.organizationId };
    if (status) query.status = status;
    if (priority) query.priority = priority;
    if (category) query.category = category;
    if (assignedTo) query.assignedTo = assignedTo;

    const total = await Ticket.countDocuments(query);
    const tickets = await Ticket.find(query)
      .populate('assignedTo', 'name email avatar photo')
      .populate('submittedBy.userId', 'name email avatar photo')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ success: true, data: tickets, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/my', authenticateToken, async (req, res) => {
  try {
    const tickets = await Ticket.find({ organizationId: req.organizationId, assignedTo: req.user._id })
      .populate('submittedBy.userId', 'name email avatar photo')
      .sort({ updatedAt: -1 });
    res.json({ success: true, data: tickets });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/client-history', authenticateToken, async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 12;
    const skip = (page - 1) * limit;

    const query = {
      organizationId: req.organizationId,
      $or: [
        { 'submittedBy.userId': req.user._id },
        { 'submittedBy.email': req.user.email }
      ]
    };

    const total = await Ticket.countDocuments(query);
    const tickets = await Ticket.find(query)
      .populate('assignedTo', 'name email avatar photo position')
      .sort({ createdAt: -1 })
      .skip(skip)
      .limit(limit);

    res.json({ success: true, data: tickets, pagination: { total, page, limit, pages: Math.ceil(total / limit) } });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.get('/:id', authenticateToken, async (req, res) => {
  try {
    const ticket = await Ticket.findOne({ _id: req.params.id, organizationId: req.organizationId })
      .populate('assignedTo', 'name email avatar photo')
      .populate('comments.author', 'name email avatar photo role');

    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket no encontrado' });
    res.json({ success: true, data: ticket });
  } catch (error) {
    res.status(500).json({ success: false, error: error.message });
  }
});

router.patch('/:id/status', authenticateToken, async (req, res) => {
  try {
    const { status } = req.body;
    const ticket = await Ticket.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket no encontrado' });

    const oldStatus = ticket.status;
    const updateData = { status, updatedAt: new Date() };
    if (status === 'resolved') updateData.resolvedAt = new Date();

    const updated = await Ticket.findOneAndUpdate(
      { _id: req.params.id, organizationId: req.organizationId },
      updateData,
      { new: true }
    ).populate('assignedTo', 'name email avatar photo');

    if (status !== oldStatus) {
      notifyStatusChanged(updated, oldStatus, status).catch(e => console.error('[Email] notifyStatusChanged:', e.message));
    }
    res.json({ success: true, data: updated });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

router.post('/:id/comments', authenticateToken, upload.array('files', 5), async (req, res) => {
  try {
    const { text, isInternal } = req.body;
    const attachments = (req.files || []).map(f => `/uploads/tickets/${f.filename}`);

    const ticket = await Ticket.findOne({ _id: req.params.id, organizationId: req.organizationId });
    if (!ticket) return res.status(404).json({ success: false, message: 'Ticket no encontrado' });

    ticket.comments.push({
      text,
      author: req.user._id,
      isInternal: isInternal === 'true' || isInternal === true,
      attachments
    });
    await ticket.save();

    const populated = await Ticket.findOne({ _id: req.params.id, organizationId: req.organizationId })
      .populate('assignedTo', 'name email avatar photo')
      .populate('comments.author', 'name email avatar photo role');

    const newComment = populated.comments[populated.comments.length - 1];
    notifyNewComment(populated, newComment, req.user).catch(e => console.error('[Email] notifyNewComment:', e.message));
    res.json({ success: true, data: newComment });
  } catch (error) {
    res.status(400).json({ success: false, error: error.message });
  }
});

module.exports = router;
