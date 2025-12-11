require('dotenv').config(); // Читаємо змінні з .env
const { program } = require('commander');
const express = require('express');
const app = express();
const fs = require('node:fs').promises;
const fsSync = require('node:fs');
const path = require('node:path');
const multer = require('multer');
const http = require('http');
const swaggerUi = require('swagger-ui-express');
const YAML = require('yamljs');
const cors = require('cors');
const mysql = require('mysql2/promise'); // Бібліотека для MySQL

app.use(cors());

// --- НАЛАШТУВАННЯ Commander.js ---
program
    .requiredOption('-h,--host <string>', 'Input IP adress of server')
    .requiredOption('-p,--port <number>', 'Input Port')
    .requiredOption('-c, --cache <path>', 'Input path ')
    .configureOutput({
        writeErr: () => { }
    });

try {
    program.parse(process.argv);
} catch (err) {
    if (err.code === 'commander.missingMandatoryOptionValue' ||
        err.message.includes('required option')) {
        console.error('Please provide required options');
        process.exit(1);
    }
}
const options = program.opts();

// --- НАЛАШТУВАННЯ КЕШУ ---
const cachePath = path.resolve(options.cache);
console.log(`Перевірка директорії кешу: ${cachePath}`);
if (!fsSync.existsSync(cachePath)) {
    fsSync.mkdirSync(cachePath, { recursive: true });
    console.log('Директорію кешу створено.');
}

// --- НАЛАШТУВАННЯ БАЗИ ДАНИХ (MySQL) ---
const pool = mysql.createPool({
    host: process.env.DB_HOST || 'db',
    user: process.env.DB_USER || 'root',
    password: process.env.DB_PASSWORD || 'secret_password',
    database: process.env.DB_NAME || 'inventory_db',
    port: process.env.DB_PORT || 3306,
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0
});

// Перевірка з'єднання
pool.getConnection()
    .then(conn => {
        console.log('Успішно підключено до бази даних MySQL!');
        conn.release();
    })
    .catch(err => {
        console.error('ПОМИЛКА підключення до БД:', err.message);
    });

// --- MULTER ---
const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, cachePath);
    },
    filename: function (req, file, cb) {
        const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
        cb(null, uniqueSuffix + path.extname(file.originalname));
    }
});
const upload = multer({ storage: storage });

app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// --- SWAGGER ---
try {
    const swaggerDocument = YAML.load('./swagger.yaml');
    app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerDocument));
} catch (e) {
    console.log("Swagger file not found.");
}

// ================= МАРШРУТИ (SQL) =================

// 1. GET /inventory (SELECT)
app.get('/inventory', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM inventory');
        
        const responseList = rows.map(item => ({
            id: item.id,
            name: item.name,
            description: item.description,
            photo: item.photo ? `/inventory/${item.id}/photo` : null
        }));
        res.json(responseList);
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// 2. POST /register (INSERT)
app.post('/register', upload.single('photo'), async (req, res) => {
    try {
        const { inventory_name, description } = req.body;
        if (!inventory_name) {
            return res.status(400).send('Bad Request: inventory_name is required');
        }

        const id = Date.now().toString();
        const photo = req.file ? req.file.filename : null;

        const sql = 'INSERT INTO inventory (id, name, description, photo) VALUES (?, ?, ?, ?)';
        await pool.query(sql, [id, inventory_name, description || '', photo]);

        res.status(201).send('Created');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// 3. GET /inventory/:id (SELECT WHERE)
app.get('/inventory/:id', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT * FROM inventory WHERE id = ?', [req.params.id]);

        if (rows.length === 0) return res.status(404).send('Not found');
        
        const item = rows[0];
        const responseItem = {
            id: item.id,
            name: item.name,
            description: item.description,
            photo: item.photo ? `/inventory/${item.id}/photo` : null
        };
        res.json(responseItem);
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// 4. PUT /inventory/:id (UPDATE)
app.put('/inventory/:id', async (req, res) => {
    try {
        const [check] = await pool.query('SELECT * FROM inventory WHERE id = ?', [req.params.id]);
        if (check.length === 0) return res.status(404).send('Not found');

        const currentItem = check[0];
        const newName = req.body.name || currentItem.name;
        const newDesc = req.body.description || currentItem.description;

        await pool.query('UPDATE inventory SET name = ?, description = ? WHERE id = ?', [newName, newDesc, req.params.id]);
        
        res.json({ ...currentItem, name: newName, description: newDesc });
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// 5. GET PHOTO
app.get('/inventory/:id/photo', async (req, res) => {
    try {
        const [rows] = await pool.query('SELECT photo FROM inventory WHERE id = ?', [req.params.id]);
        
        if (rows.length === 0 || !rows[0].photo) {
            return res.status(404).send('Not found');
        }

        const photoPath = path.join(cachePath, rows[0].photo);
        res.setHeader('Content-Type', 'image/jpeg');
        res.sendFile(photoPath);
    } catch (err) {
        res.status(404).send('Photo file missing');
    }
});

// 6. PUT PHOTO
app.put('/inventory/:id/photo', upload.single('photo'), async (req, res) => {
    try {
        const [check] = await pool.query('SELECT * FROM inventory WHERE id = ?', [req.params.id]);
        if (check.length === 0) return res.status(404).send('Not found');
        
        if (!req.file) return res.status(400).send('No file uploaded');

        await pool.query('UPDATE inventory SET photo = ? WHERE id = ?', [req.file.filename, req.params.id]);
        res.send('Photo updated');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// 7. DELETE
app.delete('/inventory/:id', async (req, res) => {
    try {
        const [result] = await pool.query('DELETE FROM inventory WHERE id = ?', [req.params.id]);
        if (result.affectedRows === 0) return res.status(404).send('Not found');
        
        res.send('Deleted');
    } catch (err) {
        console.error(err);
        res.status(500).send('Database Error');
    }
});

// HTML Forms
app.get('/RegisterForm.html', (req, res) => res.sendFile(path.join(__dirname, 'RegisterForm.html')));
app.get('/SearchForm.html', (req, res) => res.sendFile(path.join(__dirname, 'SearchForm.html')));

// SEARCH routes
app.get('/search', async (req, res) => {
    try {
        const id = req.query.id;
        const has_photo = req.query.has_photo || req.query.includePhoto;
        
        const [rows] = await pool.query('SELECT * FROM inventory WHERE id = ?', [id]);
        if (rows.length === 0) return res.status(404).send('Not Found');

        const item = rows[0];
        let responseItem = { ...item };
        if (has_photo === 'on' || has_photo === 'true') {
            responseItem.description += ` Photo link: /inventory/${item.id}/photo`;
        }
        res.json(responseItem);
    } catch (err) {
        res.status(500).send('Error');
    }
});

app.post('/search', async (req, res) => {
    try {
        const { id, has_photo } = req.body;
        const [rows] = await pool.query('SELECT * FROM inventory WHERE id = ?', [id]);
        
        if (rows.length === 0) return res.status(404).send('Not Found');

        const item = rows[0];
        let responseItem = { ...item };
        if (has_photo === 'on' || has_photo === 'true') {
            responseItem.description += ` Photo link: /inventory/${item.id}/photo`;
        }
        res.json(responseItem);
    } catch (err) {
        res.status(500).send('Error');
    }
});

const send405 = (req, res) => res.status(405).send('Method Not Allowed');
app.all('/register', send405);
app.all('/inventory', send405);

const server = http.createServer(app);
server.listen(options.port, options.host, () => {
    console.log(`Server running on http://localhost:${options.port}`);
});