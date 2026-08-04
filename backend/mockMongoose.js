// backend/mockMongoose.js
const fs = require('fs');
const path = require('path');

const dbPath = path.join(__dirname, 'db.json');

function loadDB() {
  if (!fs.existsSync(dbPath)) {
    fs.writeFileSync(dbPath, JSON.stringify({ files: [], members: [] }, null, 2));
  }
  try {
    return JSON.parse(fs.readFileSync(dbPath, 'utf8'));
  } catch (e) {
    return { files: [], members: [] };
  }
}

function saveDB(data) {
  fs.writeFileSync(dbPath, JSON.stringify(data, null, 2));
}

class Schema {
  constructor(definition) {
    this.definition = definition;
  }
}

class MockModel {
  constructor(data) {
    Object.assign(this, data);
  }

  async save() {
    const db = loadDB();
    const collection = this.constructor.collectionName;
    if (this._id) {
      const idx = db[collection].findIndex(item => item._id === this._id);
      if (idx !== -1) {
        db[collection][idx] = { ...this };
      } else {
        db[collection].push({ ...this });
      }
    } else {
      this._id = Math.random().toString(36).substring(2, 9);
      db[collection].push({ ...this });
    }
    saveDB(db);
    return this;
  }
}

function model(name, schema) {
  const collectionName = name.toLowerCase() + 's';

  class ModelClass extends MockModel {
    static get collectionName() { return collectionName; }

    static async countDocuments() {
      const db = loadDB();
      return db[collectionName] ? db[collectionName].length : 0;
    }

    static async insertMany(docs) {
      const db = loadDB();
      if (!db[collectionName]) db[collectionName] = [];
      const created = docs.map(d => ({
        _id: Math.random().toString(36).substring(2, 9),
        ...d
      }));
      db[collectionName].push(...created);
      saveDB(db);
      return created;
    }

    static async find(query = {}) {
      const db = loadDB();
      let results = db[collectionName] || [];
      if (Object.keys(query).length > 0) {
        results = results.filter(item => {
          return Object.keys(query).every(key => String(item[key]) === String(query[key]));
        });
      }
      return results;
    }

    static async findOne(query = {}) {
      const results = await this.find(query);
      return results[0] || null;
    }

    static async findOneAndDelete(query = {}) {
      const db = loadDB();
      if (!db[collectionName]) return null;
      const idx = db[collectionName].findIndex(item => {
        return Object.keys(query).every(key => String(item[key]) === String(query[key]));
      });
      if (idx !== -1) {
        const deleted = db[collectionName].splice(idx, 1)[0];
        saveDB(db);
        return deleted;
      }
      return null;
    }

    static async findByIdAndDelete(id) {
      const db = loadDB();
      if (!db[collectionName]) return null;
      const idx = db[collectionName].findIndex(item => String(item._id) === String(id));
      if (idx !== -1) {
        const deleted = db[collectionName].splice(idx, 1)[0];
        saveDB(db);
        return deleted;
      }
      return null;
    }
  }

  return ModelClass;
}

async function connect(uri) {
  // Ensure the database file is initialized with empty collections
  loadDB();
  return Promise.resolve();
}

module.exports = {
  Schema,
  model,
  connect
};
