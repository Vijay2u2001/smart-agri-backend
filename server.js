

const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: {
    origin: process.env.FRONTEND_URL || '*', // Use environment variable or fallback
    methods: ['GET', 'POST'],
  }
});

app.use(cors());
app.use(bodyParser.json());

// In-memory databases
let sensorData = {}; // key: deviceId
let historicalData = {}; // key: plantType
let waterUsage = {};     // key: date
let pendingCommands = {}; // key: deviceId

const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach'
};

// Routes
app.get('/', (req, res) => {
  res.send('🌱 Smart Agriculture Backend is Running ✅');
});

app.get('/connect', (req, res) => {
  res.send('✅ Connected to Smart Agriculture Backend');
});

app.post('/update', (req, res) => {
  const { deviceId, data } = req.body;

  if (!deviceId || !data) {
    return res.status(400).json({ error: 'Missing deviceId or data' });
  }

  // Store latest data
  sensorData[deviceId] = data;

  // Historical storage
  const plantType = devicePlantMap[deviceId] || 'unknown';
  const timestamped = { ...data, timestamp: new Date().toISOString() };

  if (!historicalData[plantType]) {
    historicalData[plantType] = [];
  }
  historicalData[plantType].push(timestamped);
  if (historicalData[plantType].length > 100) {
    historicalData[plantType].shift();
  }

  // Water usage tracking
  if (data.waterLevelPercent !== undefined) {
    const today = new Date().toISOString().split('T')[0];
    if (!waterUsage[today]) {
      waterUsage[today] = {
        startLevel: data.waterLevelPercent,
        currentLevel: data.waterLevelPercent,
        usage: 0
      };
    } else {
      waterUsage[today].currentLevel = data.waterLevelPercent;
      const tankSize = 100; // Adjust to your actual tank size
      waterUsage[today].usage =
        (waterUsage[today].startLevel - waterUsage[today].currentLevel) * tankSize / 100;
    }
  }

  // Emit update via WebSocket
  io.emit('dataUpdate', { deviceId, data });
  res.sendStatus(200);
});

app.get('/data', (req, res) => {
  res.json(sensorData);
});

app.get('/sensor-data/:plantType', (req, res) => {
  const { plantType } = req.params;
  const devices = Object.entries(devicePlantMap)
    .filter(([_, pt]) => pt === plantType)
    .map(([id]) => id);

  const data = {};
  devices.forEach((id) => {
    if (sensorData[id]) {
      data[id] = sensorData[id];
    }
  });

  if (Object.keys(data).length > 0) {
    res.json(data);
  } else {
    res.status(404).json({ error: 'No data found for ' + plantType });
  }
});

app.get('/historical-data/:plantType', (req, res) => {
  const { plantType } = req.params;
  const data = historicalData[plantType];
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `No historical data for ${plantType}` });
  }
});

app.get('/water-usage', (req, res) => {
  res.json(waterUsage);
});

app.get('/reservoir-levels', (req, res) => {
  res.json({
    waterLevel: 75,
    nutrientLevel: 60
  });
});

app.post('/control', (req, res) => {
  const { deviceId, command, value } = req.body;

  if (!deviceId || !command) {
    return res.status(400).json({ error: 'Missing deviceId or command' });
  }

  console.log(`🔧 Control command for ${deviceId}: ${command} = ${value}`);
  io.emit('controlCommand', { deviceId, command, value });

  res.json({ message: `Command '${command}' sent to device ${deviceId}` });
});

app.post('/command', (req, res) => {
  const { deviceId, command, value } = req.body;

  if (!pendingCommands[deviceId]) {
    pendingCommands[deviceId] = [];
  }

  pendingCommands[deviceId].push({
    command,
    value,
    timestamp: Date.now()
  });

  res.sendStatus(200);
});

app.get('/get-commands/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  const commands = pendingCommands[deviceId] || [];
  pendingCommands[deviceId] = []; // clear after sending
  res.json(commands);
});

// WebSocket setup
io.on('connection', (socket) => {
  console.log('📡 Frontend connected via WebSocket');
  socket.emit('initData', sensorData);

  socket.on('disconnect', () => {
    console.log('❌ Frontend disconnected');
  });
});

// Server start
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
