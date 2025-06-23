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

const devicePlantMap = {
  esp32_1: 'level1',
  esp32_2: 'level2',
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

    io.emit('commandIssued', commandObj);
    io.to(`device_${deviceId}`).emit('executeCommand', {
      command: command,
      value: commandObj.value,
      duration: commandObj.duration
    });

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

io.on('connection', (socket) => {
  const clientIp = socket.handshake.headers['x-forwarded-for'] || socket.handshake.address;
  console.log(`📡 New client connected [${socket.id}] from ${clientIp}`);

  socket.on('authenticate', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(deviceId);
      console.log(`[${socket.id}] Joined device room: ${deviceId}`);
    }
  });

  socket.on('deviceConnect', (deviceId) => {
    if (devicePlantMap[deviceId]) {
      socket.join(`device_${deviceId}`);
      deviceStates[deviceId].connected = true;
      console.log(`Device ${deviceId} connected`);
    }
  });

  socket.on('sendToDevice', (data) => {
    const { deviceId, command } = data;
    io.to(`device_${deviceId}`).emit('command', command);
  });

  socket.on('sensorUpdate', ({ deviceId, data }) => {
    if (devicePlantMap[deviceId]) {
      sensorData[deviceId] = data;
      deviceStates[deviceId].lastSeen = new Date().toISOString();
      deviceStates[deviceId].lastUpdated = new Date().toISOString();
      io.emit('sensorDataUpdated', { deviceId, data });
      console.log(`📡 Data received from ${deviceId}:`, data);
    } else {
      console.warn(`❗ Unknown device tried to send sensor data: ${deviceId}`);
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
  console.log(`[${socket.id}] Sent init data`);

  socket.on('disconnect', (reason) => {
    console.log(`❌ Client disconnected [${socket.id}]: ${reason}`);
  });

  socket.on('error', (error) => {
    console.error(`[${socket.id}] Socket error:`, error);
  });
});

const PORT = process.env.PORT || 4000;
server.listen(PORT, () => {
  console.log(`🚀 Server running on port ${PORT}`);
});
