const express = require('express');
const sqlite3 = require('sqlite3').verbose();
const bodyParser = require('body-parser');
const multer = require('multer');
const csv = require('csv-parser');
const fs = require('fs');
const path = require('path');
const app = express();
const db = new sqlite3.Database('/Users/connorrilett/Documents/Eduline/v8/data/brain.db');

// Middleware
app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public'));  // Serve static files
app.use(express.json());

// Set EJS for rendering HTML files
app.set('view engine', 'ejs');

// Set up multer to store uploaded CSVs temporarily
const upload = multer({ dest: 'uploads/' });

// Create and/or add initial students to the database
db.serialize(() => {

  //------------MASTER STUDENT LIST TABLE-------------------
  db.run(`CREATE TABLE IF NOT EXISTS master_student_list (
    oen TEXT PRIMARY KEY,
    sid TEXT,
    first_name TEXT,
    last_name TEXT
  )`);
  //------------LOGS TABLE-------------------
  db.run(`CREATE TABLE IF NOT EXISTS logs (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    action TEXT,
    timestamp timestamp DATETIME DEFAULT (datetime('now', 'localtime'))
  )`);
  //------------PENDING ARRIVALS TABLE-------------------
  db.run(`CREATE TABLE IF NOT EXISTS pending_arrivals (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    student_id TEXT,
    first_name TEXT,
    last_name TEXT,
    sent_at DATETIME DEFAULT (datetime('now', 'localtime')),
    UNIQUE(student_id)  -- Prevent duplicates
  )`);
});

// Serve index.html
app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

// Serve deskview.html
app.get('/deskview', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'deskview.html'));
});

// Log a scan (sign-in/sign-out)
app.post('/scan', (req, res) => {
  const studentId = req.body.studentId;

  db.get(`SELECT * FROM master_student_list WHERE oen = ?`, [studentId], (err, student) => {
    if (student) {
      // Check if student is signed in
      db.get(`SELECT * FROM logs WHERE student_id = ? ORDER BY id DESC LIMIT 1`, [studentId], (err, lastLog) => {
        const action = lastLog && lastLog.action === 'sign-in' ? 'sign-out' : 'sign-in';

        // Log the action in the database
        db.run(`INSERT INTO logs (student_id, action) VALUES (?, ?)`, [studentId, action]);

        // Log in the history.txt file
        const now = new Date();
        const offset = now.getTimezoneOffset() * 60000; // Offset in milliseconds
        const localTime = new Date(now.getTime() - offset).toISOString().slice(0, 19).replace('T', ' ');
        const logEntry = `${localTime} - ${student.first_name} ${student.last_name} - ${action}\n`;


        fs.appendFile('history.txt', logEntry, (err) => {
          if (err) throw err;
        });

        res.json({ 
          success: true, 
          action: action
        });
      });
    } else {
      res.status(404).json({ success: false, message: 'Student not found' });
    }
  });
});

// ————————————————————————————————————————————————
// CHECK WHO IS SIGNED IN: compare to logs
// ————————————————————————————————————————————————

app.get('/currently-signed-in', (req, res) => {
  const sql = `
    -- 1. Confirmed (signed in)
    SELECT 
      m.first_name, 
      m.last_name, 
      l.student_id, 
      l.timestamp,
      'confirmed' AS status
    FROM logs l
    JOIN master_student_list m ON l.student_id = m.oen
    WHERE l.id IN (SELECT MAX(id) FROM logs GROUP BY student_id)
      AND l.action = 'sign-in'

    UNION ALL

    -- 2. Pending arrival
    SELECT 
      first_name,
      last_name,
      student_id,
      sent_at AS timestamp,
      'pending' AS status
    FROM pending_arrivals

    ORDER BY timestamp DESC
  `;

  db.all(sql, [], (err, rows) => {
    if (err) {
      console.error(err);
      return res.status(500).json({ error: err.message });
    }
    res.json(rows);
  });
});

// ————————————————————————————————————————————————
// AUTO SIGN-OUT: Every student inactive > 360 min
// ————————————————————————————————————————————————
function autoSignOutStaleStudents() {
  const SIX_HOURS_IN_DAYS = 360 / 1440; // 360 minutes = 6 hours

  const sql = `
    INSERT INTO logs (student_id, action, timestamp)
    SELECT 
      l.student_id, 
      'sign-out',
      datetime('now', 'localtime')
    FROM logs l
    WHERE l.action = 'sign-in'
      AND l.id IN (
        SELECT MAX(id) 
        FROM logs 
        GROUP BY student_id
      )
      AND julianday('now', 'localtime') - julianday(l.timestamp) > ?
  `;

  db.run(sql, [SIX_HOURS_IN_DAYS], function (err) {
    if (err) {
      console.error('Auto sign-out error:', err);
      return;
    }
    if (this.changes > 0) {
      console.log(`Auto signed out ${this.changes} student(s) after 6+ hours.`);
    }
  });
}

// Run every 5 minutes
setInterval(autoSignOutStaleStudents, 5 * 60 * 1000);

// Run once on server start (in case of restart)
autoSignOutStaleStudents();



// ————————————————————————————————————————————————
// TEACHER SENDS STUDENT TO LIBRARY: adds to queue
// ————————————————————————————————————————————————

app.post('/send-to-library', (req, res) => {
  const { studentId } = req.body;

  db.get(`SELECT oen, first_name, last_name FROM master_student_list WHERE oen = ? OR sid = ?`, 
    [studentId, studentId], (err, student) => {
      if (!student) {
        return res.status(404).json({ success: false, message: 'Student not found' });
      }

      // Insert into pending (ignore if already there)
      db.run(`
        INSERT OR IGNORE INTO pending_arrivals (student_id, first_name, last_name)
        VALUES (?, ?, ?)
      `, [student.oen, student.first_name, student.last_name], function(err) {
        if (err) {
          console.error(err);
          return res.status(500).json({ success: false });
        }
        res.json({ success: true });
      });
  });
});


// ————————————————————————————————————————————————
// Librarian confirms student has arrived → sign in + remove from pending
// ————————————————————————————————————————————————

app.post('/confirm-arrival', (req, res) => {
  const { studentId } = req.body;

  db.serialize(() => {
    // 1. Sign them in
    db.run(`INSERT INTO logs (student_id, action) VALUES (?, 'sign-in')`, [studentId]);

    // 2. Remove from pending
    db.run(`DELETE FROM pending_arrivals WHERE student_id = ?`, [studentId], function(err) {
      if (err) {
        console.error(err);
        return res.status(500).json({ success: false });
      }
      res.json({ success: true });
    });
  });
});


// Route to search for a user in the log file
app.get('/search', (req, res) => {
    const searchTerm = req.query.q.toLowerCase(); // Convert query to lowercase

    const logFilePath = path.join(__dirname, 'history.txt');

    fs.readFile(logFilePath, 'utf-8', (err, data) => {
        if (err) {
            return res.status(500).send('Error reading log file.');
        }

        // Convert the log data to lowercase and filter based on lowercase search term
        const logs = data.split('\n').filter(line => line.toLowerCase().includes(searchTerm));

        if (logs.length === 0) {
            return res.status(404).json({ message: 'No logs found for user.' });
        }

        res.json({ logs });
    });
});

// autocomplete suggestions for barcode
app.get('/autocomplete', (req, res) => {
  const query = req.query.q;
  if (!query) {
      return res.json([]);
  }

  // Query database for matching first_name, last_name, OEN, or SID
  const sql = `
      SELECT oen, sid, first_name, last_name
      FROM master_student_list 
      WHERE oen LIKE ? 
      OR sid LIKE ? 
      OR first_name LIKE ? 
      OR last_name LIKE ?
      LIMIT 10
  `;

  const wildcardQuery = `%${query}%`;
  db.all(sql, [wildcardQuery, wildcardQuery, wildcardQuery, wildcardQuery], (err, rows) => {
      if (err) {
          return res.status(500).json({ error: err.message });
      }
      // Return matching students
      res.json(rows);
  });
});

// Get full log
app.get('/full-log', (req, res) => {
  fs.readFile('history.txt', 'utf8', (err, data) => {
    if (err) throw err;
    res.send(data.replace(/\n/g, '<br>'));
  });
});

// Handle CSV upload
app.post('/update-db', upload.single('csvFile'), (req, res) => {
  const filePath = req.file.path;
  const students = [];

  fs.createReadStream(filePath)
    .pipe(csv())
    .on('data', (row) => {
      // Expecting headers: SID,OEN,first_name,last_name
      students.push({
        sid: row.SID,
        oen: row.OEN,
        first_name: row.first_name,
        last_name: row.last_name,
      });
    })
    .on('end', () => {
      db.serialize(() => {
        // Clear existing data
        db.run('DELETE FROM master_student_list', (err) => {
          if (err) {
            console.error('Error clearing table:', err);
            res.status(500).send('Database error');
            return;
          }

          // Insert new data
          const stmt = db.prepare(`
            INSERT INTO master_student_list (sid, oen, first_name, last_name)
            VALUES (?, ?, ?, ?)
          `);

          for (const student of students) {
            stmt.run(student.sid, student.oen, student.first_name, student.last_name);
          }

          stmt.finalize();
          res.send('Database updated successfully!');
        });
      });

      // Clean up temp file
      fs.unlinkSync(filePath);
    });
});

// Clear log
app.post('/clear-log', (req, res) => {
  fs.writeFile('history.txt', '', (err) => {
    if (err) throw err;
    db.run(`DELETE FROM logs`, () => {
      res.json({ success: true });
    });
  });
});

const PORT = 3000;
app.listen(PORT, () => {
    console.log(`KIOSK running on http://localhost:${PORT}/index.html`);
    console.log(`CLASSROOM running on http://localhost:${PORT}/classroom.html`);
    console.log(`DESKVIEW running on http://localhost:${PORT}/deskview.html`);
});
