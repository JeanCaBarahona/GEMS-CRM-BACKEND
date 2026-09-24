const express = require('express');
const router = express.Router();
const multer = require('multer');
const path = require('path');
const fs = require('fs');
const Client = require('../models/Client');

// Mismo patrón de subida que cases.js/wiki.js — carpeta uploads compartida.
const projectFileStorage = multer.diskStorage({
  destination: (req, file, cb) => {
    const uploadPath = path.join(__dirname, '..', 'uploads');
    if (!fs.existsSync(uploadPath)) fs.mkdirSync(uploadPath, { recursive: true });
    cb(null, uploadPath);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1e9);
    const extension = path.extname(file.originalname);
    const basename = path.basename(file.originalname, extension);
    cb(null, basename + '-' + uniqueSuffix + extension);
  }
});
const uploadProjectFiles = multer({ storage: projectFileStorage, limits: { fileSize: 10 * 1024 * 1024 } });

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

// Proyectos con los que arranca todo cliente (Interno y Soporte). Van marcados
// como isDefault para que no se puedan borrar; los clientes anteriores los
// reciben al arrancar el servidor (services/initService.js).
const { DEFAULT_CLIENT_PROJECTS: DEFAULT_PROJECTS } = require('../services/initService');

router.post('/', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (data.nombre) data.name = data.nombre;
    if (data.telefono) data.phone = data.telefono;
    data.organizationId = req.organizationId;
    if (!data.projects || data.projects.length === 0) {
      data.projects = DEFAULT_PROJECTS.map(name => ({ name, status: 'active', isDefault: true }));
    }
    const client = new Client(data);
    await client.save();
    res.json(client);
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
    next(err);
  }
});

router.put('/:id', async (req, res, next) => {
  try {
    const data = { ...req.body };
    if (data.nombre) data.name = data.nombre;
    if (data.telefono) data.phone = data.telefono;
    delete data.organizationId; // nunca permitir reasignar org
    const client = await Client.findOneAndUpdate(tFilterById(req), data, { new: true, runValidators: true });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    res.json(client);
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
    next(err);
  }
});

router.delete('/:id', async (req, res) => {
  const client = await Client.findOne(tFilterById(req));
  if (!client) return res.status(404).json({ message: 'Client not found' });

  // No se borra un cliente con historial — se bloquea y se ofrece inactivar en su lugar.
  const Case = require('../models/Case');
  const Task = require('../models/Task');
  const Activity = require('../models/Activity');
  const Ticket = require('../models/Ticket');
  const [cases, tasks, activities, tickets] = await Promise.all([
    Case.countDocuments({ organizationId: req.organizationId, cliente_id: client._id }),
    Task.countDocuments({ organizationId: req.organizationId, clientId: client._id }),
    Activity.countDocuments({ organizationId: req.organizationId, clientId: client._id }),
    Ticket.countDocuments({ organizationId: req.organizationId, clientId: client._id })
  ]);
  const total = cases + tasks + activities + tickets;
  if (total > 0) {
    return res.status(409).json({
      message: `Este cliente tiene ${total} registro(s) asociado(s) (casos, tareas, actividades o tickets) y no se puede eliminar. Gestiona esos registros primero, o inactiva el cliente en su lugar.`,
      counts: { cases, tasks, activities, tickets }
    });
  }

  await client.deleteOne();
  res.json({ success: true });
});

// Inactivar/activar en vez de borrar — conserva la trazabilidad histórica del cliente.
router.patch('/:id/status', async (req, res) => {
  const status = req.body?.status === 'active' ? 'active' : 'inactive';
  const client = await Client.findOneAndUpdate(tFilterById(req), { status }, { new: true });
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

// ── Detail (wiki) endpoints ──
router.get('/:id/detail', async (req, res) => {
  const client = await Client.findOne(tFilterById(req));
  if (!client) return res.status(404).json({ message: 'Client not found' });
  res.json(client);
});

router.patch('/:id/detail', async (req, res, next) => {
  try {
    const updates = { ...(req.body || {}) };
    delete updates.organizationId;
    const client = await Client.findOneAndUpdate(tFilterById(req), { $set: updates }, { new: true, runValidators: true });
    if (!client) return res.status(404).json({ message: 'Client not found' });
    res.json(client);
  } catch (err) {
    if (err.name === 'ValidationError') return res.status(400).json({ message: err.message });
    next(err);
  }
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

// Enlaces externos del proyecto (Google Drive, OneDrive, etc.)
router.post('/:id/projects/:projectId/links', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const { nombre, url } = req.body || {};
  if (!nombre || !url) return res.status(400).json({ message: 'nombre y url son requeridos' });
  project.enlacesExternos.push({ nombre, url, agregadoPor: req.user?._id });
  await client.save();
  res.status(201).json(project.enlacesExternos[project.enlacesExternos.length - 1]);
});

router.delete('/:id/projects/:projectId/links/:linkId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const link = project.enlacesExternos.id(req.params.linkId);
  if (!link) return res.status(404).json({ message: 'Link not found' });
  link.deleteOne();
  await client.save();
  res.json({ success: true });
});

// Adjuntos del proyecto
router.post('/:id/projects/:projectId/files', uploadProjectFiles.array('archivos', 10), async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const nuevos = (req.files || []).map(file => ({
    nombre: file.originalname,
    url: `/uploads/${file.filename}`,
    tipo: file.mimetype,
    tamaño: file.size,
    fecha_subida: new Date()
  }));
  project.archivos.push(...nuevos);
  await client.save();
  res.status(201).json(project.archivos);
});

router.delete('/:id/projects/:projectId/files/:fileId', async (req, res) => {
  const client = await loadOwnedClient(req, res); if (!client) return;
  const project = client.projects.id(req.params.projectId);
  if (!project) return res.status(404).json({ message: 'Project not found' });
  const file = project.archivos.id(req.params.fileId);
  if (!file) return res.status(404).json({ message: 'File not found' });
  file.deleteOne();
  await client.save();
  res.json({ success: true });
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
