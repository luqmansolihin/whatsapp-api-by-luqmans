const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const fs = require('fs');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');

const port = process.env.PORT || 8000;

const app = express();
const server = http.createServer(app);
const io = socketIO(server);

app.use(express.json());
app.use(express.urlencoded({ extended: true }));
app.use(
    fileUpload({
        debug: true,
    })
);

app.get('/', (req, res) => {
    res.sendFile('index-multiple-device.html', {
        root: __dirname,
    });
});

const sessions = [];
const SESSIONS_FILE = './whatsapp-sessions.json';

const createSessionsFileIfNotExists = function () {
    if (!fs.existsSync(SESSIONS_FILE)) {
        try {
            fs.writeFileSync(SESSIONS_FILE, JSON.stringify([]));
            console.log('Sessions file created successfully.');
        } catch (err) {
            console.log('Failed to create sessions file: ', err);
        }
    }
};

createSessionsFileIfNotExists();

const setSessionsFile = function (sessions) {
    fs.writeFile(SESSIONS_FILE, JSON.stringify(sessions), function (err) {
        if (err) {
            console.log(err);
        }
    });
};

const getSessionsFile = function () {
    return JSON.parse(fs.readFileSync(SESSIONS_FILE));
};

const createSession = function (id, description) {
    console.log('Creating session: ' + id);
    const client = new Client({
        restartOnAuthFail: true,
        puppeteer: {
            headless: true,
            args: [
                '--no-sandbox',
                '--disable-setuid-sandbox',
                '--disable-dev-shm-usage',
                '--disable-accelerated-2d-canvas',
                '--no-first-run',
                '--no-zygote',
                '--single-process', // <- this one doesn't works in Windows
                '--disable-gpu',
            ],
        },
        authStrategy: new LocalAuth({
            clientId: id,
        }),
    });

    client.initialize();

    client.on('qr', (qr) => {
        console.log('QR RECEIVED', qr);
        qrcode.toDataURL(qr, (err, url) => {
            io.emit('qr', { id: id, src: url });
            io.emit('message', {
                id: id,
                text: 'QR Code received, scan please!',
            });
        });
    });

    client.on('ready', () => {
        io.emit('ready', { id: id });
        io.emit('message', { id: id, text: 'Whatsapp is ready!' });

        const savedSessions = getSessionsFile();
        const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);
        savedSessions[sessionIndex].ready = true;
        setSessionsFile(savedSessions);
    });

    client.on('authenticated', () => {
        io.emit('authenticated', { id: id });
        io.emit('message', { id: id, text: 'Whatsapp is authenticated!' });
    });

    client.on('auth_failure', function () {
        io.emit('message', { id: id, text: 'Whatsapp is unauthenticated' });
    });

    client.on('disconnected', (reason) => {
        io.emit('message', { id: id, text: 'Whatsapp is disconnected!' });
        client.destroy();
        client.initialize();

        // Menghapus pada file sessions
        const savedSessions = getSessionsFile();
        const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);
        savedSessions.splice(sessionIndex, 1);
        setSessionsFile(savedSessions);

        io.emit('remove-session', id);
    });

    // Tambahkan client ke sessions
    sessions.push({
        id: id,
        description: description,
        client: client,
    });

    // Menambahkan session ke file
    const savedSessions = getSessionsFile();
    const sessionIndex = savedSessions.findIndex((sess) => sess.id == id);

    if (sessionIndex == -1) {
        savedSessions.push({
            id: id,
            description: description,
            ready: false,
        });
        setSessionsFile(savedSessions);
    }
};

const init = function (socket) {
    const savedSessions = getSessionsFile();

    if (savedSessions.length > 0) {
        if (socket) {
            /**
             * At the first time of running (e.g. restarting the server), our client is not ready yet!
             * It will need several time to authenticating.
             *
             * So to make people not confused for the 'ready' status
             * We need to make it as FALSE for this condition
             */
            savedSessions.forEach((e, i, arr) => {
                arr[i].ready = false;
            });

            socket.emit('init', savedSessions);
        } else {
            savedSessions.forEach((sess) => {
                createSession(sess.id, sess.description);
            });
        }
    }
};

init();

// Socket IO
io.on('connection', function (socket) {
    init(socket);

    socket.on('create-session', function (data) {
        console.log('Create session: ' + data.id);
        createSession(data.id, data.description);
    });
});

// Check registered number in Whatsapp
const checkRegisteredNumber = async function (phone) {
    const isRegistered = await client.isRegisteredUser(phone);
    return isRegistered;
};

// Send Message
app.post(
    '/send-message',
    [
        body('sender').notEmpty(),
        body('phone').notEmpty(),
        body('message').notEmpty(),
    ],
    async (req, res) => {
        const errors = validationResult(req).formatWith(({ msg }) => {
            return msg;
        });

        if (!errors.isEmpty()) {
            return res.status(422).json({
                status: false,
                message: errors.mapped(),
            });
        }

        const sender = req.body.sender;
        const phone = phoneNumberFormatter(req.body.phone);
        const message = req.body.message;

        const client = sessions.find((sess) => sess.id == sender)?.client;

        // Make sure the sender is exists & ready
        if (!client) {
            return res.status(422).json({
                status: false,
                message: `The sender: ${sender} is not found!`,
            });
        }

        const isRegisteredNumber = await checkRegisteredNumber(phone);

        if (!isRegisteredNumber) {
            return res.status(422).json({
                status: false,
                message: 'Phone number is not registered',
            });
        }

        client
            .sendMessage(phone, message)
            .then((response) => {
                res.status(200).json({
                    status: true,
                    message: 'Message successfully to send.',
                });
            })
            .catch((err) => {
                res.status(500).json({
                    status: false,
                    message: 'Message failed to send',
                    error: err,
                });
            });
    }
);

// Send Message with Media
app.post(
    '/send-media',
    [body('sender').notEmpty(), body('phone').notEmpty()],
    async (req, res) => {
        const errors = validationResult(req).formatWith(({ msg }) => {
            return msg;
        });

        if (!errors.isEmpty()) {
            return res.status(422).json({
                status: false,
                message: errors.mapped(),
            });
        }

        const sender = req.body.sender;
        const phone = phoneNumberFormatter(req.body.phone);
        const caption = req.body.caption;
        const file = req.files.file;
        const media = new MessageMedia(
            file.mimetype,
            file.data.toString('base64'),
            file.name
        );

        const client = sessions.find((sess) => sess.id == sender)?.client;

        // Make sure the sender is exists & ready
        if (!client) {
            return res.status(422).json({
                status: false,
                message: `The sender: ${sender} is not found!`,
            });
        }

        const isRegisteredNumber = await checkRegisteredNumber(phone);

        if (!isRegisteredNumber) {
            return res.status(422).json({
                status: false,
                message: 'Phone number is not registered',
            });
        }

        client
            .sendMessage(phone, media, { caption: caption })
            .then((response) => {
                res.status(200).json({
                    status: true,
                    message: 'Message successfully to send.',
                });
            })
            .catch((err) => {
                res.status(500).json({
                    status: false,
                    message: 'Message failed to send',
                    error: err,
                });
            });
    }
);

server.listen(port, function () {
    console.log('App running on *:', port);
});
