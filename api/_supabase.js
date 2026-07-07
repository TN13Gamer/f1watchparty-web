const { createClient } = require('@supabase/supabase-js');
const fs = require('fs');
const path = require('path');

let supabase = null;
const url = process.env.SUPABASE_URL;
const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_ANON_KEY;

if (url && key) {
  try {
    supabase = createClient(url, key);
    console.log('[Supabase] Client initialized successfully.');
  } catch (e) {
    console.error('[Supabase] Initialization failed:', e.message);
  }
} else {
  console.warn('[Supabase] Credentials not set in environment. Running in FALLBACK mode.');
}

// In-memory fallback database for local offline mode
let localConfig = {};
const localConfigPath = path.resolve(process.cwd(), 'firestore_live_config_utf8.json');

function unwrapFirestore(val) {
    if (!val || typeof val !== 'object') return val;
    if ('stringValue' in val) return val.stringValue;
    if ('integerValue' in val) return parseInt(val.integerValue, 10);
    if ('doubleValue' in val) return parseFloat(val.doubleValue);
    if ('booleanValue' in val) return val.booleanValue;
    if ('nullValue' in val) return null;
    if ('arrayValue' in val) return (val.arrayValue.values || []).map(unwrapFirestore);
    if ('mapValue' in val) return unwrapFirestoreMap(val.mapValue.fields || {});
    return val;
}

function unwrapFirestoreMap(fields) {
    const res = {};
    if (!fields) return res;
    for (const k in fields) res[k] = unwrapFirestore(fields[k]);
    return res;
}

// Load initial config from file
try {
  if (fs.existsSync(localConfigPath)) {
    let raw = fs.readFileSync(localConfigPath, 'utf8');
    if (raw.charCodeAt(0) === 0xFEFF) raw = raw.slice(1);
    const parsed = JSON.parse(raw);
    if (parsed && parsed.fields) {
      localConfig = unwrapFirestoreMap(parsed.fields);
    } else {
      localConfig = parsed;
    }
  }
} catch (e) {
  console.warn('[Supabase Fallback] Could not load local config:', e.message);
}

// In-memory tables for local fallback
const localPolls = {};
const localVotes = []; // array of { match_id, voter_id, choice, voted_at }
const localChat = [];  // array of { id, username, text, timestamp, color, isAdmin }

const db = {
  // Config methods
  getConfig: async () => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('live_config').select('data').eq('key', 'live_config').single();
        if (error) throw error;
        return data ? data.data : {};
      } catch (e) {
        console.error('[Supabase] getConfig error:', e.message);
      }
    }
    return localConfig;
  },

  updateConfig: async (updateData) => {
    // 1) Update local config in memory
    for (const key in updateData) {
      if (updateData[key] && typeof updateData[key] === 'object' && !Array.isArray(updateData[key])) {
        localConfig[key] = {
          ...(localConfig[key] || {}),
          ...updateData[key]
        };
      } else {
        localConfig[key] = updateData[key];
      }
    }
    // Try saving locally to file so it persists locally
    try {
      fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2));
    } catch(e) {
      console.warn('[Supabase Fallback] Failed to save local config:', e.message);
    }

    // 2) Update in Supabase
    if (supabase) {
      try {
        const current = await db.getConfig();
        const merged = { ...current };
        for (const key in updateData) {
          if (updateData[key] && typeof updateData[key] === 'object' && !Array.isArray(updateData[key])) {
            merged[key] = {
              ...(merged[key] || {}),
              ...updateData[key]
            };
          } else {
            merged[key] = updateData[key];
          }
        }

        const { error } = await supabase.from('live_config').upsert({ key: 'live_config', data: merged, updated_at: new Date().toISOString() });
        if (error) throw error;
      } catch (e) {
        console.error('[Supabase] updateConfig error:', e.message);
      }
    }
  },

  setConfig: async (setData, options = {}) => {
    if (options.merge) {
      return db.updateConfig(setData);
    }
    localConfig = { ...setData };
    try {
      fs.writeFileSync(localConfigPath, JSON.stringify(localConfig, null, 2));
    } catch(e) {
      console.warn('[Supabase Fallback] Failed to save local config:', e.message);
    }

    if (supabase) {
      try {
        const { error } = await supabase.from('live_config').upsert({ key: 'live_config', data: setData, updated_at: new Date().toISOString() });
        if (error) throw error;
      } catch (e) {
        console.error('[Supabase] setConfig error:', e.message);
      }
    }
  },

  // Poll / Vote methods
  getPoll: async (matchId) => {
    if (supabase) {
      try {
        const { data, error } = await supabase.from('fifa_polls').select('home, away, draw').eq('match_id', matchId).single();
        if (error && error.code !== 'PGRST116') throw error;
        if (data) {
          return { home: data.home || 0, away: data.away || 0, draw: data.draw || 0, total: (data.home || 0) + (data.away || 0) + (data.draw || 0) };
        }
      } catch (e) {
        console.error('[Supabase] getPoll error:', e.message);
      }
    }
    const p = localPolls[matchId] || { home: 0, away: 0, draw: 0 };
    return { home: p.home, away: p.away, draw: p.draw, total: p.home + p.away + p.draw };
  },

  castVote: async (matchId, voterId, choice) => {
    let alreadyVoted = null;

    if (supabase) {
      try {
        await supabase.from('fifa_polls').insert({ match_id: matchId }).onConflict('match_id').ignore();

        const { data: existingVote } = await supabase.from('fifa_votes').select('choice').eq('match_id', matchId).eq('voter_id', voterId).single();
        if (existingVote) {
          alreadyVoted = existingVote.choice;
        } else {
          const { error: insertErr } = await supabase.from('fifa_votes').insert({ match_id: matchId, voter_id: voterId, choice });
          if (!insertErr) {
            const { data: currentPoll } = await supabase.from('fifa_polls').select('home, away, draw').eq('match_id', matchId).single();
            const home = (currentPoll?.home || 0) + (choice === 'home' ? 1 : 0);
            const away = (currentPoll?.away || 0) + (choice === 'away' ? 1 : 0);
            const draw = (currentPoll?.draw || 0) + (choice === 'draw' ? 1 : 0);
            await supabase.from('fifa_polls').update({ home, away, draw, updated_at: new Date().toISOString() }).eq('match_id', matchId);
          }
        }
      } catch (e) {
        console.error('[Supabase] castVote error:', e.message);
      }
    } else {
      if (!localPolls[matchId]) {
        localPolls[matchId] = { home: 0, away: 0, draw: 0 };
      }
      const existing = localVotes.find(v => v.match_id === matchId && v.voter_id === voterId);
      if (existing) {
        alreadyVoted = existing.choice;
      } else {
        localVotes.push({ match_id: matchId, voter_id: voterId, choice, voted_at: new Date().toISOString() });
        localPolls[matchId][choice] += 1;
      }
    }

    const poll = await db.getPoll(matchId);
    return { ...poll, voted: alreadyVoted || choice };
  },

  // Chat messages methods
  getChatMessages: async (limit = 60) => {
    if (supabase) {
      try {
        const { data, error } = await supabase
          .from('chat_messages')
          .select('id, username, text, timestamp, color, isAdmin')
          .order('timestamp', { ascending: false })
          .limit(limit);
        if (error) throw error;
        return (data || []).map(m => ({
          id: m.id,
          username: m.username,
          text: m.text,
          timestamp: m.timestamp ? new Date(m.timestamp).getTime() : Date.now(),
          color: m.color || '#a970ff',
          isAdmin: !!m.isAdmin
        })).reverse();
      } catch (e) {
        console.error('[Supabase] getChatMessages error:', e.message);
      }
    }
    return localChat.slice(-limit);
  },

  addChatMessage: async (message) => {
    const newMessage = {
      id: message.id || Math.random().toString(36).substring(2, 15),
      username: message.username,
      text: message.text,
      timestamp: Date.now(),
      color: message.color || '#a970ff',
      isAdmin: !!message.isAdmin
    };

    if (supabase) {
      try {
        const { error } = await supabase.from('chat_messages').insert({
          username: newMessage.username,
          text: newMessage.text,
          timestamp: new Date().toISOString(),
          color: newMessage.color,
          isAdmin: newMessage.isAdmin
        });
        if (error) throw error;
      } catch (e) {
        console.error('[Supabase] addChatMessage error:', e.message);
      }
    }

    localChat.push(newMessage);
    if (localChat.length > 100) localChat.shift();
    return newMessage;
  },

  deleteChatMessage: async (id) => {
    if (supabase) {
      try {
        const { error } = await supabase.from('chat_messages').delete().eq('id', id);
        if (error) throw error;
      } catch (e) {
        console.error('[Supabase] deleteChatMessage error:', e.message);
      }
    }
    const idx = localChat.findIndex(m => m.id === id);
    if (idx !== -1) localChat.splice(idx, 1);
    return true;
  },

  clearChatMessages: async () => {
    if (supabase) {
      try {
        const { error } = await supabase.from('chat_messages').delete().neq('username', '');
        if (error) throw error;
      } catch (e) {
        console.error('[Supabase] clearChatMessages error:', e.message);
      }
    }
    localChat.length = 0;
    return true;
  }
};

module.exports = { supabase, db };
