const express = require('express');
const router = express.Router();
const multer = require('multer');

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

let whatsappSock;

const init = (sock) => {
    whatsappSock = sock;
};

// Debug middleware
router.use((req, res, next) => {
    console.log('Middleware kirimMedia triggered for:', req.method, req.originalUrl);
    next();
});

router.post('/', (req, res, next) => {
    console.log('Route POST / matched');
    upload.single('image')(req, res, (err) => {
        if (err) {
            console.error('Multer error:', err);
            return res.status(400).json({ status: 'error', message: 'File upload error', details: err.message });
        }
        next();
    });
}, async (req, res) => {
    console.log('Handler executing');
    const { number, message } = req.body;
    const imageFile = req.file;

    if (!whatsappSock) {
        return res.status(500).json({ status: 'error', message: 'WhatsApp connection not established.' });
    }

    if (!number || !imageFile) {
        return res.status(400).json({ status: 'error', message: 'Parameters "number" and "image" (file) are required.' });
    }

    try {
        const messageOptions = {
            image: imageFile.buffer,
            caption: message || ''
        };

        await whatsappSock.sendMessage(number + '@s.whatsapp.net', messageOptions);
        res.json({ status: 'success', message: 'Image sent successfully.' });
    } catch (error) {
        console.error('Error sending image:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send image.', details: error.message });
    }
});

module.exports = { router, init };
