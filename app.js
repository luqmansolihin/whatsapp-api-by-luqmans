const { Client, LocalAuth, MessageMedia } = require('whatsapp-web.js');
const express = require('express');
const { body, validationResult } = require('express-validator');
const socketIO = require('socket.io');
const qrcode = require('qrcode');
const http = require('http');
const { phoneNumberFormatter } = require('./helpers/formatter');
const fileUpload = require('express-fileupload');

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
    res.sendFile('index.html', {
        root: __dirname,
    });
});

const client = new Client({
    restartOnAuthFail: true,
    puppeteer: {
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
        headless: true,
    },
    authStrategy: new LocalAuth(),
});

client.on('message', (msg) => {
    if (msg.body == '!ping') {
        msg.reply('pong');
        client.sendSeen(msg.id);
    }
});

client.initialize();

// Socket IO
io.on('connection', function (socket) {
    socket.emit('message', 'an user connected');

    client.on('qr', (qr) => {
        // Generate and scan this code with your phone
        console.log('QR RECEIVED', qr);
        qrcode.toDataURL(qr, (err, url) => {
            socket.emit('qr', url);
            socket.emit('message', 'QR Received, scan please!');
        });
    });

    client.on('ready', () => {
        console.log('Client is ready!');
        socket.emit('ready', 'Whatsapp is ready!');
        socket.emit('message', 'Whatsapp is ready!');
    });

    client.on('authenticated', () => {
        console.log('AUTHENTICATED');
        socket.emit('authenticated', 'Whatsapp is authenticated!');
        socket.emit('message', 'Whatsapp is authenticated!');
    });

    client.on('auth_failure', (msg) => {
        // Fired if session restore was unsuccessful
        console.error('AUTHENTICATION FAILURE', msg);
        socket.emit('unauthenticated', 'Whatsapp is unauthenticated!');
        socket.emit('message', 'Whatsapp is unauthenticated!');
    });

    client.on('disconnected', (reason) => {
        socket.emit('message', 'Whatsapp is disconnected!');
        client.destroy();
        client.initialize();
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
    [body('phone').notEmpty(), body('message').notEmpty()],
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

        const phone = phoneNumberFormatter(req.body.phone);
        const message = req.body.message;

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
app.post('/send-media', [body('phone').notEmpty()], async (req, res) => {
    const errors = validationResult(req).formatWith(({ msg }) => {
        return msg;
    });

    if (!errors.isEmpty()) {
        return res.status(422).json({
            status: false,
            message: errors.mapped(),
        });
    }

    const phone = phoneNumberFormatter(req.body.phone);
    const caption = req.body.caption;
    const file = req.files.file;
    const media = new MessageMedia(
        file.mimetype,
        file.data.toString('base64'),
        file.name
    );

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
});

server.listen(3000, function () {
    console.log('App running on *:', 3000);
});
