const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: "*"
  }
});

app.use(cors());
app.use(bodyParser.json());

app.get('/connect', (req, res) => {
  res.send('✅ Connected to Smart Agriculture Backend');
});
// ✅ Root route to confirm backend is live
app.get('/', (req, res) => {
  res.send('🌱 Smart Agriculture Backend is Running ✅');
});

app.get('/sensor-data/:plantType', (req, res) => {
    const { plantType } = req.params;
    const data = sensorData[plantType];  // Access data by plant type
    if (data) {
        res.json(data);
    } else {
        res.status(404).json({ error: 'No data found for ' + plantType });
    }
});

// In-memory storage for sensor data
let sensorData = {};

// ✅ ESP32 sends data here
app.post('/update', (req, res) => {
  const { deviceId, data } = req.body;

  if (!deviceId || !data) {
    return res.status(400).send('Missing deviceId or data');
  }

  sensorData[deviceId] = data;

  // Broadcast update to all connected frontend clients
  io.emit('dataUpdate', { deviceId, data });

  res.sendStatus(200);
});

// ✅ Frontend fetches data here
app.get('/data', (req, res) => {
  res.json(sensorData);
});

// ✅ Frontend real-time updates with Socket.IO
io.on('connection', (socket) => {
  console.log('📡 Frontend connected via WebSocket');
  socket.emit('initData', sensorData);

  socket.on('disconnect', () => {
    console.log('❌ Frontend disconnected');
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
