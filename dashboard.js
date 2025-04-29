module.exports = function startDashboardServer() {
const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs-extra');
const path = require('path');
const YAML = require('yaml');
const bot = require('./index'); // or wherever your main bot logic lives
const app = express();
const PORT = 3002;
const CONFIG_PATH = path.join(__dirname, 'spotipack_config.yaml');

app.use(bodyParser.urlencoded({ extended: true }));
app.use(express.static('public')); // where your dashboard.html is located

// Serve dashboard HTML
app.get('/', (req, res) => {
    res.sendFile(path.join(__dirname, 'public', 'dashboard.html'));
});

app.use(express.json());

app.post('/api/config', async (req, res) => {
    try {
        const newConfig = req.body;

        // Convert comma-separated strings back to arrays
        const arrayFields = [
            'added_to_queue_messages',
            'usage_types',
            'command_alias',
            'command_user_level',
            'skip_user_level',
            'volume_set_level',
            'ignore_max_length',
            'blocked_tracks'
        ];

        for (const key of arrayFields) {
            if (typeof newConfig[key] === 'string') {
                newConfig[key] = newConfig[key].split(',').map(s => s.trim()).filter(Boolean);
            }
        }

        // Convert certain values to booleans
        const boolFields = [
            'automatic_refunds',
            'logs',
            'use_song_command',
            'use_queue_command',
            'use_exact_amount_of_bits',
            'allow_vote_skip',
            'allow_volume_set',
            'use_cooldown'
        ];
        for (const key of boolFields) {
            newConfig[key] = newConfig[key] === 'true' || newConfig[key] === true;
        }

        // Write back to YAML
        const yamlString = YAML.stringify(newConfig);
        await fs.writeFile(CONFIG_PATH, yamlString, 'utf8');

        //Reload the config in the main bot
        bot.reloadConfig();

        res.json({ success: true });
    } catch (err) {
        console.error('Failed to save config:', err);
        res.status(500).json({ error: 'Failed to save config' });
    }
});


// Handle config update form POST
app.post('/save-config', async (req, res) => {
    try {
        const formData = req.body;

        const updatedConfig = {
            user_name: formData.user_name,
            channel_name: formData.channel_name,
            usage_message: formData.usage_message,
            wrong_format_message: formData.wrong_format_message,
            added_to_queue_messages: [formData.added_to_queue_messages],
            song_not_found: formData.song_not_found,
            max_duration: parseInt(formData.max_duration),

            custom_reward_id: formData.custom_reward_id,
            automatic_refunds: formData.automatic_refunds === 'true',
            custom_reward_name: formData.custom_reward_name,
            custom_reward_cost: parseInt(formData.custom_reward_cost),

            express_port: parseInt(formData.express_port),
            logs: formData.logs === 'true',

            usage_types: formData.usage_types.split(',').map(s => s.trim()),
            command_alias: formData.command_alias.split(',').map(s => s.trim()),
            command_user_level: formData.command_user_level.split(',').map(s => s.trim()),
            use_song_command: formData.use_song_command === 'true',
            use_queue_command: formData.use_queue_command === 'true',
            queue_display_depth: parseInt(formData.queue_display_depth),

            minimum_requred_bits: parseInt(formData.minimum_requred_bits),
            use_exact_amount_of_bits: formData.use_exact_amount_of_bits === 'true',

            skip_alias: formData.skip_alias,
            skip_user_level: formData.skip_user_level.split(',').map(s => s.trim()),
            allow_vote_skip: formData.allow_vote_skip === 'true',
            required_vote_skip: parseInt(formData.required_vote_skip),
            voteskip_timeout: parseInt(formData.voteskip_timeout),

            allow_volume_set: formData.allow_volume_set === 'true',
            volume_set_level: formData.volume_set_level.split(',').map(s => s.trim()),
            ignore_max_length: formData.ignore_max_length.split(',').map(s => s.trim()),

            use_cooldown: formData.use_cooldown === 'true',
            cooldown_duration: parseInt(formData.cooldown_duration),

            blocked_tracks: formData.blocked_tracks.split(',').map(s => s.trim())
        };

        await fs.writeFile(CONFIG_PATH, YAML.stringify(updatedConfig));
        res.send('Configuration saved successfully! You can close this tab.');
    } catch (err) {
        console.error('Error saving config:', err);
        res.status(500).send('Failed to save configuration.');
    }
});

// Send current YAML config as JSON to frontend
app.get('/api/config', async (req, res) => {
    try {
        const fileContent = await fs.readFile(CONFIG_PATH, 'utf8');
        const config = YAML.parse(fileContent);
        res.json(config);
    } catch (err) {
        console.error('Failed to read config:', err);
        res.status(500).json({ error: 'Failed to load config' });
    }
});


app.listen(PORT, () => {
    console.log(`Dashboard running at http://localhost:${PORT}`);
});

function getCurrentTrack() {
    return axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: getSpotifyHeaders()
    }).then(res => {
        if (res.data && res.data.item) {
            return res.data.item.name;
        } else {
            return null;
        }
    }).catch(err => {
        console.error('Error fetching current track:', err);
        return null;
    });
}
}