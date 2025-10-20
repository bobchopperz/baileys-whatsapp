// ini adalah class untuk kirim pesan menggunakan root

// contoh payload : curl -X POST http://localhost:8000/kirim-pesan \
// -H "Content-Type: application/json" \
// -d '{"number": "6281234567890", "message": "Halo wak !"}'

const express = require('express');
const router = express.Router();

// Import sock dari index.js (akan kita passing nanti)
let whatsappSock;

// Fungsi untuk menginisialisasi sock
const init = (sock) => {
    whatsappSock = sock;
};

router.post('/', async (req, res) => {
    const { number, message } = req.body;

    if (!whatsappSock) {
        return res.status(500).json({ status: 'error', message: 'WhatsApp connection not established.' });
    }

    if (!number || !message) {
        return res.status(400).json({ status: 'error', message: 'Both "number" and "message" are required.' });
    }

    try {
        // Contoh pengiriman pesan teks
        await whatsappSock.sendMessage(number + '@s.whatsapp.net', { text: message });
        res.json({ status: 'success', message: 'Message sent successfully.' });
    } catch (error) {
        console.error('Error sending message:', error);
        res.status(500).json({ status: 'error', message: 'Failed to send message.', details: error.message });
    }
});

module.exports = { router, init };