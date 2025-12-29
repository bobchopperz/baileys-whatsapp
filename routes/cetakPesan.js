// routes/cetakPesan.js
const express = require('express');
const router = express.Router();

// Variable untuk menyimpan socket printer yang aktif
let printerSocket = null;

// Fungsi untuk meng-update socket printer (dipanggil dari index.js)
const setPrinterSocket = (socket) => {
    printerSocket = socket;
};

router.post('/', (req, res) => {
    const { sender, message } = req.body;

    // 1. Cek apakah ada printer yang terhubung
    if (!printerSocket) {
        return res.status(503).json({ 
            status: 'error', 
            message: 'No printer connected via WebSocket.' 
        });
    }

    // 2. Validasi Input
    if (!message) {
        return res.status(400).json({ 
            status: 'error', 
            message: 'Parameter "message" is required.' 
        });
    }

    try {
        // 3. Forward pesan ke Android via WebSocket
        // Format disamakan dengan format pesan WhatsApp agar Android tidak perlu ubah logic
        printerSocket.emit('print_message', {
            sender: sender || 'Server API', // Default sender jika tidak ada
            message: message,
            timestamp: new Date().toISOString()
        });

        // 4. Beri respon sukses ke pengirim request
        res.json({ 
            status: 'success', 
            message: 'Message forwarded to printer.' 
        });

    } catch (error) {
        console.error('Error forwarding to printer:', error);
        res.status(500).json({ 
            status: 'error', 
            message: 'Internal server error while forwarding.' 
        });
    }
});

module.exports = { router, setPrinterSocket };
