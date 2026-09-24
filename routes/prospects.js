const express = require('express')
const router = express.Router()
const ProspectConversation = require('../models/ProspectConversation')

// Campos editables vía PATCH (whitelist para evitar overrides)
const PATCHABLE_FIELDS = [
  'prospectName',
  'company',
  'status',
  'estimatedValue',
  'source',
  'contactName',
  'contactEmail',
  'contactPhone',
  'ownerId'
]

// ──────────── CONVERSACIONES ────────────

// Crear nueva conversación
router.post('/', async (req, res) => {
  try {
    const { prospectName, company, createdBy, initialMessage } = req.body
    const conversation = new ProspectConversation({
      organizationId: req.organizationId,
      prospectName,
      company,
      createdBy: createdBy || null,
      messages: initialMessage ? [{ role: 'user', content: initialMessage }] : []
    })
    conversation.addTimelineEntry('created', `Prospecto creado: ${prospectName}`)
    await conversation.save()
    res.status(201).json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Listar todas
router.get('/', async (req, res) => {
  try {
    const conversations = await ProspectConversation.find({ organizationId: req.organizationId })
      .populate('createdBy', 'name email photo')
      .populate('ownerId', 'name email')
      .sort({ lastUpdated: -1 })
    res.json(conversations)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Obtener una
router.get('/:id', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
      .populate('createdBy', 'name email photo')
      .populate('ownerId', 'name email')
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Agregar mensaje
router.post('/:id/message', async (req, res) => {
  try {
    const { role, content } = req.body
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })
    conversation.messages.push({ role, content })
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// PATCH metadata (status, valor, fuente, contacto, owner, etc.) — granular
router.patch('/:id', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })

    const updates = {}
    PATCHABLE_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) updates[field] = req.body[field]
    })

    // Si cambió el status, registramos en timeline
    if (updates.status && updates.status !== conversation.status) {
      conversation.addTimelineEntry('status', `Estado cambiado a "${updates.status}"`, {
        previous: conversation.status,
        current: updates.status
      })
    }

    Object.assign(conversation, updates)
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Compatibilidad: PUT también permite editar (legacy)
router.put('/:id', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })

    PATCHABLE_FIELDS.forEach((field) => {
      if (req.body[field] !== undefined) conversation[field] = req.body[field]
    })
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Eliminar prospecto
router.delete('/:id', async (req, res) => {
  try {
    const result = await ProspectConversation.findOneAndDelete({ _id: req.params.id, organizationId: req.organizationId })
    if (!result) return res.status(404).json({ error: 'No encontrada' })
    res.json({ success: true })
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ──────────── NOTAS ────────────

router.post('/:id/notes', async (req, res) => {
  try {
    const { content, author } = req.body
    if (!content || !content.trim()) {
      return res.status(400).json({ error: 'El contenido es requerido' })
    }
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })

    conversation.notes.unshift({ content, author })
    conversation.addTimelineEntry(
      'note',
      content.slice(0, 80) + (content.length > 80 ? '…' : '')
    )
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id/notes/:noteId', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })
    conversation.notes = conversation.notes.filter((n) => n._id.toString() !== req.params.noteId)
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ──────────── TAREAS ────────────

router.post('/:id/tasks', async (req, res) => {
  try {
    const { title, dueDate } = req.body
    if (!title || !title.trim()) {
      return res.status(400).json({ error: 'El título es requerido' })
    }
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })

    conversation.tasks.unshift({
      title,
      dueDate: dueDate ? new Date(dueDate) : undefined,
      done: false
    })
    conversation.addTimelineEntry('task_created', `Tarea: "${title}"`, { dueDate })
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// Toggle done/undone
router.patch('/:id/tasks/:taskId/toggle', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })
    const task = conversation.tasks.id(req.params.taskId)
    if (!task) return res.status(404).json({ error: 'Tarea no encontrada' })

    task.done = !task.done
    task.doneAt = task.done ? new Date() : undefined

    if (task.done) {
      conversation.addTimelineEntry('task_completed', `Tarea completada: "${task.title}"`)
    }

    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

router.delete('/:id/tasks/:taskId', async (req, res) => {
  try {
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })
    conversation.tasks = conversation.tasks.filter((t) => t._id.toString() !== req.params.taskId)
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

// ──────────── TIMELINE ────────────

// Permite que el cliente registre eventos manuales (outreach, ai_summary, etc.)
router.post('/:id/timeline', async (req, res) => {
  try {
    const { type, description, meta } = req.body
    if (!type || !description) {
      return res.status(400).json({ error: 'type y description son requeridos' })
    }
    const conversation = await ProspectConversation.findOne({ _id: req.params.id, organizationId: req.organizationId })
    if (!conversation) return res.status(404).json({ error: 'No encontrada' })

    conversation.addTimelineEntry(type, description, meta)
    conversation.lastUpdated = Date.now()
    await conversation.save()
    res.json(conversation)
  } catch (err) {
    res.status(500).json({ error: err.message })
  }
})

module.exports = router
