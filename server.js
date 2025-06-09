const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, {
  cors: { origin: '*' }
});

app.use(cors());
app.use(bodyParser.json());

// In-memory database
let sensorData = {}; // key: deviceId, value: latest sensor data
let historicalData = {}; // key: plantType, value: array of historical entries

// Optional: map deviceId to plantType
const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach'
};

// Root test route
app.get('/', (req, res) => {
  res.send('🌱 Smart Agriculture Backend is Running ✅');
});

// Ping route
app.get('/connect', (req, res) => {
  res.send('✅ Connected to Smart Agriculture Backend');
});

// Update route from ESP32
app.post('/update', (req, res) => {
  const { deviceId, data } = req.body;

  if (!deviceId || !data) {
    return res.status(400).json({ error: 'Missing deviceId or data' });
  }

  // Store live data
  sensorData[deviceId] = data;

  // Store historical data by plant type
  const plantType = devicePlantMap[deviceId] || 'unknown';
  const timestamped = { ...data, timestamp: new Date().toISOString() };

  if (!historicalData[plantType]) {
    historicalData[plantType] = [];
  }
  historicalData[plantType].push(timestamped);

  // Limit to last 100 entries (optional)
  if (historicalData[plantType].length > 100) {
    historicalData[plantType].shift();
  }

  // Emit via WebSocket
  io.emit('dataUpdate', { deviceId, data });

  res.sendStatus(200);
});

// Frontend fetches all live data
app.get('/data', (req, res) => {
  res.json(sensorData);
});

// Get live sensor data by plant type
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

// Track water usage
let waterUsage = {};

app.post('/update', (req, res) => {
  // ... existing code ...
  
  // Track water level changes
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
      // Calculate usage based on your tank size
      const tankSize = 100; // in liters, adjust to your actual tank size
      waterUsage[today].usage = 
        (waterUsage[today].startLevel - waterUsage[today].currentLevel) * tankSize / 100;
    }
  }
  
  // ... rest of your code ...
});

// Add new endpoint for water usage
app.get('/water-usage', (req, res) => {
  res.json(waterUsage);
});
// Get historical sensor data
app.get('/historical-data/:plantType', (req, res) => {
  const { plantType } = req.params;
  const data = historicalData[plantType];
  if (data) {
    res.json(data);
  } else {
    res.status(404).json({ error: `No historical data for ${plantType}` });
  }
});

// Handle control commands (e.g., turn on pump from frontend)
app.post('/control', (req, res) => {
  const { deviceId, command, value } = req.body;

  if (!deviceId || !command) {
    return res.status(400).json({ error: 'Missing deviceId or command' });
  }

  console.log(`🔧 Control command for ${deviceId}: ${command} = ${value}`);

  io.emit('controlCommand', { deviceId, command, value });

  res.json({ message: `Command '${command}' sent to device ${deviceId}` });
});

// Dummy reservoir endpoint
app.get('/reservoir-levels', (req, res) => {
  const reservoirData = {
    waterLevel: 75,
    nutrientLevel: 60
  };
  res.json(reservoirData);
});

// WebSocket connection
io.on('connection', (socket) => {
  console.log('📡 Frontend connected via WebSocket');
  socket.emit('initData', sensorData);

  socket.on('disconnect', () => {
    console.log('❌ Frontend disconnected');
  });
});

// Start the server
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
