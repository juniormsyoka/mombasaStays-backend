require('dotenv').config();

const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const path = require('path');

const app = express(); // ✅ FIRST create app

//app.use(cors());

// In your server.js, update CORS
app.use(cors({
  origin: ['http://localhost:3000', 'https://your-admin-domain.com'],
  credentials: true
}));
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
   SUPERADMIN MIDDLEWARE
================================ */

function requireAdmin(req, res, next) {
    const key = req.headers['x-admin-key'];
    if (key !== process.env.ADMIN_KEY) {
        return res.status(401).json({ error: 'Unauthorized' });
    }
    next();
}

/* ================================
   SUPERADMIN: DASHBOARD STATS
================================ */

app.get('/api/admin/stats', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                (SELECT COUNT(*) FROM users WHERE role = 'host')                          AS total_hosts,
                (SELECT COUNT(*) FROM users WHERE role = 'host' AND is_verified = true)   AS verified_hosts,
                (SELECT COUNT(*) FROM listings WHERE is_active = true)                    AS active_listings,
                (SELECT COUNT(*) FROM listings WHERE is_active = false)                   AS inactive_listings,
                (SELECT COUNT(*) FROM listings WHERE is_featured = true)                  AS featured_listings,
                (SELECT COUNT(*) FROM subscriptions WHERE is_active = true)               AS active_subscriptions,
                (SELECT COUNT(*) FROM subscriptions WHERE plan_type = 'featured' AND is_active = true) AS featured_subs,
                (SELECT COUNT(*) FROM listings)                                           AS total_listings
        `);
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: GET ALL HOSTS
================================ */

app.get('/api/admin/hosts', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                u.id,
                u.name,
                u.phone,
                u.whatsapp,
                u.is_verified,
                u.created_at,
                COUNT(l.id)                                         AS listing_count,
                COALESCE(s.plan_type, 'none')                       AS plan_type,
                s.is_active                                         AS sub_active,
                s.end_date                                          AS sub_end_date
            FROM users u
            LEFT JOIN listings l    ON l.host_id = u.id
            LEFT JOIN subscriptions s ON s.host_id = u.id AND s.is_active = true
            WHERE u.role = 'host'
            GROUP BY u.id, s.plan_type, s.is_active, s.end_date
            ORDER BY u.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: CREATE HOST
================================ */

app.post('/api/admin/hosts', requireAdmin, async (req, res) => {
    const { name, phone, whatsapp, plan_type } = req.body;

    if (!name || !phone) {
        return res.status(400).json({ error: 'name and phone are required' });
    }

    try {
        // Create the user
        const userResult = await pool.query(
            `INSERT INTO users (name, phone, whatsapp, role, is_verified)
             VALUES ($1, $2, $3, 'host', true)
             RETURNING *`,
            [name, phone, whatsapp || phone]
        );

        const newHost = userResult.rows[0];

        // If a plan is provided, create a subscription
        if (plan_type && plan_type !== 'none') {
            const endDate = new Date();
            endDate.setMonth(endDate.getMonth() + 1); // 1 month from now
            await pool.query(
                `INSERT INTO subscriptions (host_id, plan_type, start_date, end_date, is_active)
                 VALUES ($1, $2, CURRENT_DATE, $3, true)`,
                [newHost.id, plan_type, endDate.toISOString().split('T')[0]]
            );
        }

        res.status(201).json(newHost);
    } catch (error) {
        if (error.code === '23505') {
            return res.status(409).json({ error: 'Phone number already registered' });
        }
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: EDIT HOST
================================ */

app.patch('/api/admin/hosts/:id', requireAdmin, async (req, res) => {
    const { name, phone, whatsapp, is_verified } = req.body;
    const { id } = req.params;

    try {
        const result = await pool.query(
            `UPDATE users
             SET
                name        = COALESCE($1, name),
                phone       = COALESCE($2, phone),
                whatsapp    = COALESCE($3, whatsapp),
                is_verified = COALESCE($4, is_verified)
             WHERE id = $5 AND role = 'host'
             RETURNING *`,
            [name, phone, whatsapp, is_verified, id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Host not found' });
        }

        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: SUSPEND / UNSUSPEND HOST
   Toggles is_verified + deactivates their listings
================================ */

app.patch('/api/admin/hosts/:id/suspend', requireAdmin, async (req, res) => {
    const { id } = req.params;
    const { suspend } = req.body; // true = suspend, false = reinstate

    try {
        // Toggle host verified status
        await pool.query(
            `UPDATE users SET is_verified = $1 WHERE id = $2 AND role = 'host'`,
            [!suspend, id]
        );

        // Deactivate or reactivate all their listings
        await pool.query(
            `UPDATE listings SET is_active = $1 WHERE host_id = $2`,
            [!suspend, id]
        );

        res.json({ success: true, suspended: suspend });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: DELETE HOST
   Also deletes their listings and images (cascade)
================================ */

app.delete('/api/admin/hosts/:id', requireAdmin, async (req, res) => {
    const { id } = req.params;

    try {
        // Delete listing images first
        await pool.query(
            `DELETE FROM listing_images WHERE listing_id IN
             (SELECT id FROM listings WHERE host_id = $1)`, [id]
        );
        // Delete listings
        await pool.query(`DELETE FROM listings WHERE host_id = $1`, [id]);
        // Delete subscriptions
        await pool.query(`DELETE FROM subscriptions WHERE host_id = $1`, [id]);
        // Delete host
        const result = await pool.query(
            `DELETE FROM users WHERE id = $1 AND role = 'host' RETURNING id`, [id]
        );

        if (result.rows.length === 0) {
            return res.status(404).json({ error: 'Host not found' });
        }

        res.json({ success: true, deleted_id: parseInt(id) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: GET ALL LISTINGS (no geo filter)
================================ */

app.get('/api/admin/listings', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(`
            SELECT
                l.id,
                l.title,
                l.description,
                l.price_kes,
                l.location_name,
                l.is_active,
                l.is_featured,
                l.created_at,
                ST_X(l.location::geometry) AS longitude,
                ST_Y(l.location::geometry) AS latitude,
                u.id   AS host_id,
                u.name AS host_name,
                u.phone AS host_phone,
                COALESCE(
                    (SELECT json_agg(json_build_object('id', li.id, 'image_url', li.image_url))
                     FROM listing_images li WHERE li.listing_id = l.id),
                    '[]'::json
                ) AS images
            FROM listings l
            JOIN users u ON u.id = l.host_id
            ORDER BY l.created_at DESC
        `);
        res.json(result.rows);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: TOGGLE LISTING ACTIVE
================================ */

app.patch('/api/admin/listings/:id/toggle', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE listings SET is_active = NOT is_active WHERE id = $1 RETURNING id, is_active`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: TOGGLE FEATURED
================================ */

app.patch('/api/admin/listings/:id/feature', requireAdmin, async (req, res) => {
    try {
        const result = await pool.query(
            `UPDATE listings SET is_featured = NOT is_featured WHERE id = $1 RETURNING id, is_featured`,
            [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
        res.json(result.rows[0]);
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: DELETE LISTING
================================ */

app.delete('/api/admin/listings/:id', requireAdmin, async (req, res) => {
    try {
        await pool.query(`DELETE FROM listing_images WHERE listing_id = $1`, [req.params.id]);
        const result = await pool.query(
            `DELETE FROM listings WHERE id = $1 RETURNING id`, [req.params.id]
        );
        if (result.rows.length === 0) return res.status(404).json({ error: 'Listing not found' });
        res.json({ success: true, deleted_id: parseInt(req.params.id) });
    } catch (error) {
        console.error(error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

/* ================================
   SUPERADMIN: UPSERT SUBSCRIPTION
================================ */

app.post('/api/admin/hosts/:id/subscription', requireAdmin, async (req, res) => {
    const { plan_type, months = 1 } = req.body;
    const { id } = req.params;

    try {
        // Deactivate any existing subscription first
        await pool.query(
            `UPDATE subscriptions SET is_active = false WHERE host_id = $1`, [id]
        );

        if (plan_type === 'none') {
            return res.json({ success: true, plan: 'none' });
        }

        const endDate = new Date();
        endDate.setMonth(endDate.getMonth() + parseInt(months));

        const result = await pool.query(
            `INSERT INTO subscriptions (host_id, plan_type, start_date, end_date, is_active)
             VALUES ($1, $2, CURRENT_DATE, $3, true)
             RETURNING *`,
            [id, plan_type, endDate.toISOString().split('T')[0]]
        );

        // If featured plan, set all their listings as featured
        if (plan_type === 'featured') {
            await pool.query(
                `UPDATE listings SET is_featured = true WHERE host_id = $1`, [id]
            );
        } else {
            await pool.query(
                `UPDATE listings SET is_featured = false WHERE host_id = $1`, [id]
            );
        }

        res.json(result.rows[0]);
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