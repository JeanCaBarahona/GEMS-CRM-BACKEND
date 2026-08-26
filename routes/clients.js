const express = require('express');
const router = express.Router();
const Client = require('../models/Client');

// Helper: filtro base de tenant + (opcional) _id
const tFilter = (req, extra = {}) => ({ organizationId: req.organizationId, ...extra });
const tFilterById = (req) => ({ _id: req.params.id, organizationId: req.organizationId });

// ── Listado y CRUD principal ──
router.get('/', async (req, res) => {
  const clients = await Client.find(tFilter(req)).sort({ createdAt: -1 });
  res.json(clients);
});

router.get('/:id', async (req, res) => {
  const client = await Client.findOne(tFilterById(req));
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

router.post('/', async (req, res) => {
  const data = { ...req.body };
  if (data.nombre) data.name = data.nombre;
  if (data.telefono) data.phone = data.telefono;
  data.organizationId = req.organizationId;
  const client = new Client(data);
  await client.save();
  res.json(client);
});

router.put('/:id', async (req, res) => {
  const data = { ...req.body };
  if (data.nombre) data.name = data.nombre;
  if (data.telefono) data.phone = data.telefono;
  delete data.organizationId; // nunca permitir reasignar org
  const client = await Client.findOneAndUpdate(tFilterById(req), data, { new: true });
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

router.delete('/:id', async (req, res) => {
  const result = await Client.findOneAndDelete(tFilterById(req));
  if (!result) return res.status(404).json({ message: 'Client not found' });
  res.json({ success: true });
});

// ── Detail (wiki) endpoints ──
router.get('/:id/detail', async (req, res) => {
  const client = await Client.findOne(tFilterById(req));
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

router.patch('/:id/detail', async (req, res) => {
  const updates = { ...(req.body || {}) };
  delete updates.organizationId;
  const client = await Client.findOneAndUpdate(tFilterById(req), { $set: updates }, { new: true });
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

// ── Helper para sub-recursos: carga el cliente scoped por tenant ──
async function loadOwnedClient(req, res) {
  const client = await Client.findOne(tFilterById(req));
  if (!client) {
    res.status(404).json({ message: 'Client not found' });
    return null;
  }
  return client;
}

// Notes
router.post('/:id/notes', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const { content, author, pinned } = req.body;
  client.notes.push({ content, author, pinned });
  await client.save();
  res.json(client.notes[client.notes.length - 1]);
});

router.put('/:id/notes/:noteId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const note = client.notes.id(req.params.noteId);
  if (!note) return res.status(404).json({ message: 'Note not found' });
  Object.assign(note, req.body);
  await client.save();
  res.json(note);
});

router.delete('/:id/notes/:noteId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const note = client.notes.id(req.params.noteId);
  if (!note) return res.status(404).json({ message: 'Note not found' });
  note.deleteOne();
  await client.save();
  res.json({ success: true });
});

// Services
router.post('/:id/services', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  client.services.push(req.body);
  await client.save();
  res.json(client.services[client.services.length - 1]);
});

router.put('/:id/services/:serviceId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const service = client.services.id(req.params.serviceId);
  if (!service) return res.status(404).json({ message: 'Service not found' });
  Object.assign(service, req.body);
  await client.save();
  res.json(service);
});

router.delete('/:id/services/:serviceId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const service = client.services.id(req.params.serviceId);
  if (!service) return res.status(404).json({ message: 'Service not found' });
  service.deleteOne();
  await client.save();
  res.json({ success: true });
});

// ── Projects ──
router.get('/:id/projects', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  res.json(client.projects || []);
});

router.post('/:id/projects', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const name = (req.body?.name || '').trim();
  if (!name) return res.status(400).json({ message: 'El nombre del proyecto es obligatorio' });
  const dup = (client.projects || []).some(p => p.name.trim().toLowerCase() === name.toLowerCase());
  if (dup) return res.status(409).json({ message: 'Ya existe un proyecto con ese nombre' });
  client.projects.push({ ...req.body, name });
  await client.save();
  res.status(201).json(client.projects[client.projects.length - 1]);
});

router.put('/:id/projects/:projectId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const { isDefault, ...rest } = req.body || {};
  if (rest.name !== undefined) {
    const name = (rest.name || '').trim();
    if (!name) return res.status(400).json({ message: 'El nombre del proyecto es obligatorio' });
    const dup = (client.projects || []).some(
      p => String(p._id) !== String(project._id) && p.name.trim().toLowerCase() === name.toLowerCase()
    );
    if (dup) return res.status(409).json({ message: 'Ya existe un proyecto con ese nombre' });
    rest.name = name;
  }
  Object.assign(project, rest);
  await client.save();
  res.json(project);
});

router.delete('/:id/projects/:projectId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  if (project.isDefault) {
    return res.status(400).json({ message: 'El proyecto por defecto no se puede eliminar' });
  }
  // No se borra si tiene trabajo asociado: se archiva para no dejar tareas huérfanas.
  const Task = require('../models/Task');
  const Activity = require('../models/Activity');
  const [tasks, activities] = await Promise.all([
    Task.countDocuments({ organizationId: req.organizationId, projectId: project._id }),
    Activity.countDocuments({ organizationId: req.organizationId, projectId: project._id })
  ]);
  if (tasks + activities > 0) {
    project.status = 'archived';
    await client.save();
    return res.json({
      success: true,
      archived: true,
      message: `El proyecto tiene ${tasks} tarea(s) y ${activities} actividad(es) asociadas, así que se archivó en lugar de eliminarse.`
    });
  }
  project.deleteOne();
  await client.save();
  res.json({ success: true, archived: false });
});

// Commitments
router.post('/:id/commitments', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  client.commitments.push(req.body);
  await client.save();
  res.json(client.commitments[client.commitments.length - 1]);
});

router.put('/:id/commitments/:commitmentId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const item = client.commitments.id(req.params.commitmentId);
  if (!item) return res.status(404).json({ message: 'Commitment not found' });
  Object.assign(item, req.body);
  await client.save();
  res.json(item);
});

router.delete('/:id/commitments/:commitmentId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const item = client.commitments.id(req.params.commitmentId);
  if (!item) return res.status(404).json({ message: 'Commitment not found' });
  item.deleteOne();
  await client.save();
  res.json({ success: true });
});

module.exports = router;
