'use strict';
const fs = require('fs');

const ACCOUNTS_FILE = 'accounts.json';

class AccountManager {
  constructor() {
    this.list = [];
    this.current = 0;
  }

  getCurrent() {
    if (this.list.length === 0) return null;
    return this.list[this.current];
  }

  switchTo(name) {
    const idx = this.list.findIndex(a => a.name === name);
    if (idx === -1) return false;
    this.current = idx;
    return true;
  }

  loadFromFile() {
    try {
      const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (!data.accounts) return;
      for (const [name, val] of Object.entries(data.accounts)) {
        if (!val.user_id) continue;
        this.list.push({
          name,
          user_id: val.user_id,
          credential_json: JSON.stringify(val.credential),
          jwt_token: null,
          jwt_exp: 0,
        });
      }
    } catch (_) {}
  }

  deleteAccount(name) {
    const idx = this.list.findIndex(a => a.name === name);
    if (idx === -1) return false;
    this.list.splice(idx, 1);
    if (this.current >= this.list.length) {
      this.current = Math.max(0, this.list.length - 1);
    }
    try {
      const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
      const data = JSON.parse(content);
      if (data.accounts) {
        delete data.accounts[name];
        fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
      }
    } catch (_) {}
    return true;
  }
}

function addAccount(name, userId, accessTokenJson) {
  let data = { accounts: {} };
  try {
    const content = fs.readFileSync(ACCOUNTS_FILE, 'utf-8');
    data = JSON.parse(content);
    if (!data.accounts) data.accounts = {};
  } catch (_) {}

  data.accounts[name] = {
    user_id: userId,
    credential: JSON.parse(accessTokenJson),
  };

  fs.writeFileSync(ACCOUNTS_FILE, JSON.stringify(data, null, 2));
}

module.exports = { AccountManager, addAccount };
