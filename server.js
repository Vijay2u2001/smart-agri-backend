
const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { cors: { origin: "*" } });

app.use(cors());
app.use(bodyParser.json());

// In-memory storage for sensor data
let sensorData = {};

// Endpoint to receive updates from ESP32
app.post('/update', (req, res) => {
    const { deviceId, data } = req.body;
    sensorData[deviceId] = data;
    io.emit('dataUpdate', { deviceId, data });
    res.sendStatus(200);
});

// Endpoint for frontend to fetch sensor data
app.get('/data', (req, res) => {
    res.json(sensorData);
});

// Handle socket.io connections
io.on('connection', (socket) => {
    console.log('Client connected');
    socket.emit('initData', sensorData);
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});
