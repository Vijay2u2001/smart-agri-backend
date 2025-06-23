const express = require('express');
const cors = require('cors');
const bodyParser = require('body-parser');
const http = require('http');
const { Server } = require('socket.io');

const app = express();
const server = http.createServer(app);

// Enhanced Socket.IO configuration
const io = new Server(server, {
  cors: {
    origin: [
      'https://smart-agriculture-box.netlify.app',
      'http://localhost:3000', // For local development
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
});

// Enhanced CORS configuration
const corsOptions = {
  origin: [
    'https://smart-agriculture-box.netlify.app',
    'http://localhost:3000', // For local development
  ],
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization'],
  credentials: true,
};
app.use(cors(corsOptions));

app.use(bodyParser.json({ limit: '10mb' }));
app.use(bodyParser.urlencoded({ extended: true, limit: '10mb' }));

// Add pre-flight OPTIONS handler
app.options('*', cors(corsOptions));

// Enable trust proxy for secure connections
app.enable('trust proxy');

// Constants
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

// In-memory databases with persistence
let sensorData = {};
let historicalData = {};
let waterUsage = {};
let pendingCommands = {};
let deviceStates = {};

const devicePlantMap = {
  esp32_1: 'lettuce',
  esp32_2: 'spinach',
};

// Initialize device states
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

// Enhanced logging middleware
app.use((req, res, next) => {
  const timestamp = new Date().toISOString();
  console.log([${timestamp}] ${req.method} ${req.url});
  if (req.method === 'POST' && req.body) {
    console.log('Request Body:', JSON.stringify(req.body, null, 2));
  }
  next();
});

// API Documentation Endpoint
app.get('/', (req, res) => {
  res.json({
    status: 'running',
    message: '🌱 Smart Agriculture Backend',
    version: '2.3.0',
    frontend: 'https://smart-agriculture-box.netlify.app',
    endpoints: {
      update: 'POST /update',
      data: 'GET /data',
      sensorData: 'GET /sensor-data/:plantType',
      historicalData: 'GET /historical-data/:plantType',
      sendCommand: 'POST /send-command',
      getCommands: 'GET /get-commands/:deviceId',
      deviceStatus: 'GET /device-status/:deviceId',
      connect: 'GET /connect',
      debug: {
        connections: '/debug/connections',
        clients: '/debug/ws-clients',
        devices: '/debug/devices',
      },
    },
  });
});

// Device status endpoint
app.get('/device-status/:deviceId', (req, res) => {
  const { deviceId } = req.params;
  if (!deviceStates[deviceId]) {
    return res.status(404).json({
      error: 'Device not found',
      availableDevices: Object.keys(deviceStates),
    });
  }
  res.json({
    ...deviceStates[deviceId],
    plantType: devicePlantMap[deviceId] || 'unknown',
  });
});

// Command endpoints for Arduino
app.post('/send-command', (req, res) => {
  try {
    const { deviceId, command, value, duration } = req.body;

    // Validate input
    if (!deviceId || !command) {
      return res.status(400).json({
        error: 'Missing required fields',
        required: ['deviceId', 'command'],
        received: Object.keys(req.body),
      });
    }

    // Validate command type
    if (!Object.values(COMMAND_TYPES).includes(command)) {
      return res.status(400).json({
        error: 'Invalid command type',
        validCommands: Object.values(COMMAND_TYPES),
      });
    }

    // Create command object
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

    // Initialize command queue if not exists
    if (!pendingCommands[deviceId]) {
      pendingCommands[deviceId] = [];
    }
    pendingCommands[deviceId].push(commandObj);

    // Update device state (predictive)
    if (command === COMMAND_TYPES.LIGHT_ON || command === COMMAND_TYPES.LED) {
      deviceStates[deviceId].light = true;
    } else if (command === COMMAND_TYPES.LIGHT_OFF) {
      deviceStates[deviceId].light = false;
    } else if (command === COMMAND_TYPES.WATER_PLANT || command === COMMAND_TYPES.WATER_PUMP) {
      deviceStates[deviceId].lastWatered = new Date().toISOString();
    } else if (command === COMMAND_TYPES.ADD_NUTRIENTS || command === COMMAND_TYPES.FERT_PUMP) {
      deviceStates[deviceId].lastNutrients = new Date().toISOString();
    }

    console.log(New command queued for ${deviceId}:, commandObj);

    // Broadcast via WebSocket
    io.emit('commandIssued', commandObj);

    // Set timeout for command (5 minutes)
    const timeout = setTimeout(() => {
      const cmdIndex = pendingCommands[deviceId].findIndex((c) => c.id === commandObj.id);
      if (cmdIndex !== -1 && pendingCommands[deviceId][cmdIndex].status === COMMAND_STATUS.PENDING) {
        pendingCommands[deviceId][cmdIndex].status = COMMAND_STATUS.TIMEOUT;
        pendingCommands[deviceId][cmdIndex].timeoutAt = new Date().toISOString();
        io.emit('commandTimeout', pendingCommands[deviceId][cmdIndex]);
        console.log(Command ${commandObj.id} timed out);
      }
    }, 5 * 60 * 1000); // 5 minutes

    // Store timeout reference for cleanup
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

// Debug Endpoints
app.get('/debug/connections', (req, res) => {
  res.json({
    activeSockets: io.engine.clientsCount,
    connectedDevices: Object.keys(deviceStates).filter((id) => deviceStates[id].connected),
    lastUpdates: Object.keys(sensorData).map((id) => ({
      device: id,
      plant: devicePlantMap[id] || 'unknown',
      lastUpdate: deviceStates[id].lastUpdated,
      data: sensorData[id],
    })),
  });
});

app.get('/debug/ws-clients', (req, res) => {
  const clients = [];
  io.sockets.sockets.forEach((socket) => {
    clients.push({
      id: socket.id,
      connected: socket.connected,
      handshake: {
        headers: socket.handshake.headers,
        query: socket.handshake.query,
        time: socket.handshake.time,
        address: socket.handshake.address,
      },
    });
  });
  res.json(clients);
});

app.get('/debug/devices', (req, res) => {
  res.json(deviceStates);
});

// Enhanced WebSocket Connection Handling
io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(📡 New client connected [${socket.id}] from ${clientIp});

  socket.on('authenticate', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(deviceId);
      console.log([${socket.id}] Joined device room: ${deviceId});
    }
  });

  const initData = {
    sensorData,
    deviceStates,
    pendingCommands: Object.keys(pendingCommands).reduce((acc, key) => {
      acc[key] = pendingCommands[key].filter((cmd) => cmd.status === COMMAND_STATUS.PENDING);
      return acc;
    }, {}),
    timestamp: new Date().toISOString(),
  };

  socket.emit('init', initData);
  console.log([${socket.id}] Sent init data);

  socket.on('requestCommand', (data) => {
    try {
      const { deviceId, command, value, duration } = data;

      if (!deviceId || !command) {
        return socket.emit('commandError', {
          error: 'Missing deviceId or command',
          received: data,
        });
      }

      io.emit('commandRequested', {
        deviceId,
        command,
        value,
        duration: duration || 3000,
        requestedBy: socket.id,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      console.error([${socket.id}] Error in requestCommand:, error);
      socket.emit('error', {
        message: 'Failed to process command request',
        error: error.message,
      });
    }
  });

  socket.on('disconnect', (reason) => {
    console.log(❌ Client disconnected [${socket.id}]: ${reason});
  });

  socket.on('error', (error) => {
    console.error([${socket.id}] Socket error:, error);
  });
});

// Server startup
const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(🚀 Server running on port ${PORT});
});
