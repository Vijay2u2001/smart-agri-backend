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

// Add this in your backend code (e.g., index.js or server.js)

app.get('/historical-data/:plantType', (req, res) => {
    const { plantType } = req.params;

    // Dummy historical data for demo purposes
    const historicalData = {
        lettuce: [
            { timestamp: '2025-05-28T10:00:00Z', temperature: 25, humidity: 60, waterLevel: 70 },
            { timestamp: '2025-05-28T12:00:00Z', temperature: 26, humidity: 58, waterLevel: 68 },
            // More historical entries can be added here
        ],
        spinach: [
            { timestamp: '2025-05-28T10:00:00Z', temperature: 24, humidity: 65, waterLevel: 72 }
        ]
        // Add more plant types as needed
    };

    const data = historicalData[plantType];
    if (data) {
        res.json(data);
    } else {
        res.status(404).json({ error: `No historical data for ${plantType}` });
    }
});

// Add this route to your backend (index.js or server.js)

app.post('/control', (req, res) => {
    const { deviceId, command, value } = req.body;

    // Here you can handle the control commands
    // For demo, let's just log it and emit it via Socket.IO
    console.log(`Received control command for ${deviceId}:`, command, value);
    
    // Emit to connected clients/devices via socket.io
    io.emit('controlCommand', { deviceId, command, value });

    // Respond success
    res.json({ message: `Command '${command}' sent to device ${deviceId}` });
});

app.get('/reservoir-levels', (req, res) => {
    // Replace this with real data from your ESP32/IoT system
    const reservoirData = {
        waterLevel: 75,   // e.g., percentage or cm
        nutrientLevel: 60 // e.g., percentage or ppm
    };

    res.json(reservoirData);
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
