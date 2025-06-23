const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

const io = new Server(server, {
  cors: {
    origin: [
      'https://smart-agriculture-box.netlify.app',
      'http://localhost:3000',
    ],
    methods: ['GET', 'POST'],
    credentials: true,
  },
  connectionStateRecovery: {
    maxDisconnectionDuration: 2 * 60 * 1000,
    skipMiddlewares: true,
  },
  pingInterval: 10000,
  pingTimeout: 5000,
  path: '/ws' // Add this line to handle WebSocket connections at /ws endpoint
});

const corsOptions = {
  origin: [
    'https://smart-agriculture-box.netlify.app',
    'http://localhost:3000',
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));
app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));
app.options('*', cors(corsOptions));
app.enable('trust proxy');

const COMMAND_TYPES = {
  LIGHT_ON: 'light_on',
  LIGHT_OFF: 'light_off',
  WATER_PLANT: 'water_plant',
  ADD_NUTRIENTS: 'add_nutrients',
  WATER_PUMP: 'water_pump',
  FERT_PUMP: 'fert_pump',
  LED: 'led',
};

const COMMAND_STATUS = {
  PENDING: 'pending',
  COMPLETED: 'completed',
  FAILED: 'failed',
  TIMEOUT: 'timeout',
};

let sensorData = {};
let historicalData = {};
let waterUsage = {};
let pendingCommands = {};
let deviceStates = {};

// Updated device mapping to match frontend expectations
const devicePlantMap = {
  esp32_1: 'level1',  // Changed from 'lettuce'
  esp32_2: 'level2'   // Changed from 'spinach'
};

const initializeDeviceStates = () => {
  Object.keys(devicePlantMap).forEach((deviceId) => {
    deviceStates[deviceId] = {
      connected: false,
      lastSeen: null,
      light: false,
      pump: false,
      lastWatered: null,
      lastNutrients: null,
      lastUpdated: new Date().toISOString(),
    };
  });
};
initializeDeviceStates();

app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log(`[${timestamp}] ${req.method} ${req.url}`);
  if (req.method === 'POST' && req.body) {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// ... [Keep all your existing routes unchanged until the send-command endpoint] ...

app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, value, duration } = req.body;

    if (!deviceId || !command) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        received: Object.keys(req.body),
      });
    }

    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return res.status(400).json({
        error: 'Invalid command type',
        validCommands: Object.values(COMMAND_TYPES),
      });
    }

    const commandObj = {
      id: Date.now().toString(),
      command,
      value: value !== undefined ? value : [COMMAND_TYPES.LIGHT_ON, COMMAND_TYPES.WATER_PUMP, COMMAND_TYPES.FERT_PUMP, COMMAND_TYPES.LED].includes(command) ? 1 : 0,
      deviceId,
      duration: duration || 3000,
      timestamp: new Date().toISOString(),
      status: COMMAND_STATUS.PENDING,
      issuedBy: req.ip,
    };

    if (!pendingCommands[deviceId]) {
      pendingCommands[deviceId] = [];
    }
    pendingCommands[deviceId].push(commandObj);

    // Update device states
    if (command === COMMAND_TYPES.LIGHT_ON || command === COMMAND_TYPES.LED) {
      deviceStates[deviceId].light = true;
    } else if (command === COMMAND_TYPES.LIGHT_OFF) {
      deviceStates[deviceId].light = false;
    } else if (command === COMMAND_TYPES.WATER_PLANT || command === COMMAND_TYPES.WATER_PUMP) {
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    } else if (command === COMMAND_TYPES.ADD_NUTRIENTS || command === COMMAND_TYPES.FERT_PUMP) {
      deviceStates[deviceId].lastNutrients = new Date().toISOString();
    }

    console.log(`New command queued for ${deviceId}:`, commandObj);

    // Send command to the specific device via WebSocket
    io.to(`device_${deviceId}`).emit('executeCommand', {
      command: command,
      value: commandObj.value,
      duration: commandObj.duration,
      commandId: commandObj.id
    });

    io.emit('commandIssued', commandObj);

    const timeout = setTimeout(() => {
      const cmdIndex = pendingCommands[deviceId].findIndex((c) => c.id === commandObj.id);
      if (cmdIndex !== -1 && pendingCommands[deviceId][cmdIndex].status === COMMAND_STATUS.PENDING) {
        pendingCommands[deviceId][cmdIndex].status = COMMAND_STATUS.TIMEOUT;
        pendingCommands[deviceId][cmdIndex].timeoutAt = new Date().toISOString();
        io.emit('commandTimeout', pendingCommands[deviceId][cmdIndex]);
        console.log(`Command ${commandObj.id} timed out`);
      }
    }, 5 * 60 * 1000);

    commandObj.timeoutRef = timeout;

    res.json({
      status: 'success',
      message: 'Command received and queued',
      command: commandObj,
    });
  } catch (error) {
    console.error('Error in /send-command:', error);
    res.status(500).json({
      error: 'Internal server error',
      message: error.message,
    });
  }
});

// ... [Keep all your existing routes unchanged] ...

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`📡 New client connected [${socket.id}] from ${clientIp}`);

  // Handle ESP32 device connections
  socket.on('deviceConnect', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(`device_${deviceId}`);
      deviceStates[deviceId].connected = true;
      deviceStates[deviceId].lastSeen = new Date().toISOString();
      console.log(`Device ${deviceId} connected`);
      
      // Send pending commands to the device upon connection
      if (pendingCommands[deviceId] && pendingCommands[deviceId].length > 0) {
        const pending = pendingCommands[deviceId].filter(cmd => cmd.status === COMMAND_STATUS.PENDING);
        socket.emit('pendingCommands', pending);
        console.log(`Sent ${pending.length} pending commands to ${deviceId}`);
      }
    }
  });

  // Handle command completion notifications from devices
  socket.on('commandCompleted', (data) => {
    const { commandId, deviceId, success } = data;
    if (pendingCommands[deviceId]) {
      const cmdIndex = pendingCommands[deviceId].findIndex(cmd => cmd.id === commandId);
      if (cmdIndex !== -1) {
        pendingCommands[deviceId][cmdIndex].status = success ? COMMAND_STATUS.COMPLETED : COMMAND_STATUS.FAILED;
        pendingCommands[deviceId][cmdIndex].completedAt = new Date().toISOString();
        
        // Clear the timeout
        if (pendingCommands[deviceId][cmdIndex].timeoutRef) {
          clearTimeout(pendingCommands[deviceId][cmdIndex].timeoutRef);
        }

        io.emit('commandUpdate', pendingCommands[deviceId][cmdIndex]);
        console.log(`Command ${commandId} marked as ${pendingCommands[deviceId][cmdIndex].status}`);
      }
    }
  });

  // Handle sensor data updates from devices
  socket.on('sensorData', (data) => {
    const { deviceId, sensors } = data;
    if (devicePlantMap[deviceId]) {
      sensorData[deviceId] = sensors;
      deviceStates[deviceId].lastUpdated = new Date().toISOString();
      deviceStates[deviceId].connected = true;
      deviceStates[deviceId].lastSeen = new Date().toISOString();
      
      // Broadcast the update to all clients
      io.emit('sensorUpdate', {
        deviceId,
        plantType: devicePlantMap[deviceId],
        data: sensors,
        timestamp: deviceStates[deviceId].lastUpdated
      });
    }
  });

  // ... [Keep the rest of your existing socket.io code] ...
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
