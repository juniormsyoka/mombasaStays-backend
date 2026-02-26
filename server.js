require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express(); // ✅ FIRST create app

app.use(cors());
app.use(express.json());

// ✅ THEN serve static files
app.use(express.static(path.join(__dirname)));

/* ================================
   DATABASE CONNECTION
================================ */
/*
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
});*/

// Replace local pool with:
const pool = new Pool({
    connectionString: process.env.DATABASE_URL,
    ssl: { rejectUnauthorized: false }
});

pool.query('SELECT NOW()')
  .then(res => console.log('✅ PostgreSQL connected! Time:', res.rows[0]))
  .catch(err => console.error('❌ DB connection error:', err));

/* ================================
   HEALTH CHECK
================================ */

app.get('/health', (req, res) => {
    res.json({ status: 'ok' });
});

/* ================================
   GET LISTINGS NEARBY (PostGIS)
================================ */

app.get('/api/listings/nearby', async (req, res) => {
    const { lat, lng, radius = 5000 } = req.query; // radius in meters

    if (!lat || !lng) {
        return res.status(400).json({ error: 'lat and lng are required' });
    }

    try {
        const query = `
            SELECT 
                l.id,
                l.host_id,
                l.title,
                l.description,
                l.price_kes,
                l.location_name,
                l.is_featured,
                ST_X(l.location::geometry) AS longitude,
                ST_Y(l.location::geometry) AS latitude,
                ST_Distance(
                    l.location,
                    ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography
                ) AS distance,
                (
                    SELECT json_agg(
                        json_build_object(
                            'id', li.id,
                            'image_url', li.image_url
                        )
                    )
                    FROM listing_images li
                    WHERE li.listing_id = l.id
                ) AS images
            FROM listings l
            WHERE l.is_active = true
            AND ST_DWithin(
                l.location,
                ST_SetSRID(ST_MakePoint($1, $2), 4326)::geography,
                $3
            )
            ORDER BY l.is_featured DESC, distance ASC;
        `;

        const values = [lng, lat, radius];

        const result = await pool.query(query, values);
        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   GET SINGLE LISTING
================================ */

app.get('/api/listings/:id', async (req, res) => {
    try {
        const query = `
            SELECT 
                l.*,
                ST_X(l.location::geometry) AS latitude,
                ST_Y(l.location::geometry) AS longitude,
                u.name AS host_name,
                u.phone AS host_phone,
                u.whatsapp AS host_whatsapp,
                COALESCE(
                    (
                        SELECT json_agg(
                            json_build_object(
                                'id', li.id,
                                'image_url', li.image_url
                            )
                        )
                        FROM listing_images li
                        WHERE li.listing_id = l.id
                    ),
                    '[]'::json
                ) AS images
            FROM listings l
            JOIN users u ON l.host_id = u.id
            WHERE l.id = $1
        `;

        const result = await pool.query(query, [req.params.id]);

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Listing not found' });
        }

        res.json(result.rows[0]);

    } catch (error) {
        console.error('Error fetching listing:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================

/* ================================
   GET LISTING IMAGES
================================ */

app.get('/api/listings/:id/images', async (req, res) => {
    try {
        const query = `
            SELECT id, image_url
            FROM listing_images
            WHERE listing_id = $1
            ORDER BY id;
        `;

        const result = await pool.query(query, [req.params.id]);
        res.json(result.rows);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   ADMIN: CREATE LISTING
================================ */

app.post('/api/admin/listings', async (req, res) => {
    const key = req.headers['x-admin-key'];

    if (key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    const {
        host_id,
        title,
        description,
        price_kes,
        latitude,
        longitude,
        location_name
    } = req.body;

    if (!host_id || !title || !price_kes || !latitude || !longitude) {
        return res.status(400).json({ error: 'Missing required fields' });
    }

    try {
        const query = `
            INSERT INTO listings (
                host_id,
                title,
                description,
                price_kes,
                location,
                location_name
            )
            VALUES (
                $1,
                $2,
                $3,
                $4,
                ST_SetSRID(ST_MakePoint($5, $6), 4326)::geography,
                $7
            )
            RETURNING *;
        `;

        const values = [
            host_id,
            title,
            description,
            price_kes,
            longitude, // IMPORTANT: lng first
            latitude,
            location_name
        ];

        const result = await pool.query(query, values);
        res.status(201).json(result.rows[0]);

    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   START SERVER
================================ */

const PORT = process.env.PORT || 5000;

app.listen(PORT, () => {
    console.log(`Server running on port ${PORT}`);
});