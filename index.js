const express = require('express');
const fs = require('fs');
const YAML = require('yaml');
const tmi = require('tmi.js');
const axios = require('axios').default;
const open = require('open');
const Twitch = require('./twitchcontroller');
const pack = require('./package.json');
const path = require('path');

let spotifyRefreshToken = '';
let spotifyAccessToken = '';
let voteskipTimeout;

const client_id = process.env.SPOTIFY_CLIENT_ID;
const client_secret = process.env.SPOTIFY_CLIENT_SECRET;
const twitchOauthTokenRefunds = process.env.TWITCH_OAUTH_TOKEN_REFUNDS;
const twitchClientId = process.env.TWITCH_CLIENT_ID;
const twitchOauthToken = process.env.TWITCH_OAUTH_TOKEN;

const channelPointsUsageType = 'channel_points';
const commandUsageType = 'command';
const bitsUsageType = 'bits';
const defaultRewardId = 'xxx-xxx-xxx-xxx';
const displayNameTag = 'display-name';

const streamer = 'streamer';
const mod = 'mod';
const vip = 'vip';
const sub = 'sub';
const everyone = 'everyone';

const spotifyShareUrlBase = 'https://open.spotify.com';
const spotifyShareUrlMaker = `${spotifyShareUrlBase}/track/`;
const spotifyShareUrlMakerRegex = `${spotifyShareUrlBase}/(?:.*)?track/[^\\s]+`;
const spotifyShareUriMaker = 'spotify:track:';

const currentConfig = setupYamlConfigs();
const expressPort = currentConfig.express_port;
const cooldownDuration = currentConfig.cooldown_duration * 1000;
const usersOnCooldown = new Set();
const usersHaveSkipped = new Set();

const volMin = 0;
const volMax = 100;
const clamp = (num, volMin, volMax) => Math.min(Math.max(num, volMin), volMax);

// CHECK FOR UPDATES
axios.get("https://api.github.com/repos/KumoKairo/Spotify-Twitch-Song-Requests/releases/latest")
    .then(r => {
        if (r.data.tag_name !== pack.version) {
            console.log(`An update is available at ${r.data.html_url}`);
        }
    }, () => console.log("Failed to check for updates."));

// TWITCH SETUP
(async () => {
    const twitchAPI = new Twitch();
    await twitchAPI.init(currentConfig); // no token or ID passed
    console.log(twitchAPI.token)
    const client = new tmi.Client({
        options: { debug: true },
        connection: {
            secure: true,
            reconnect: true
        },
        identity: {
            username: currentConfig.user_name,
            password: `oauth:${twitchAPI.token}`
        },
        channels: [ currentConfig.channel_name ]
    });
    
    client.connect().catch(console.error);
    
    console.log(`Logged in as ${currentConfig.user_name}. Working on channel '${currentConfig.channel_name}'`);
    
    client.on('message', async (channel, tags, message, self) => {
        if(self) return;
        let messageToLower = message.toLowerCase();
    
        if(currentConfig.usage_types.includes(commandUsageType)
            && currentConfig.command_alias.includes(messageToLower.split(" ")[0])
            && isUserEligible(channel, tags, currentConfig.command_user_level)) {
            let args = messageToLower.split(" ")[1];
                if (!args) {
                    client.say(currentConfig.channel_name, `${tags[displayNameTag]}, usage: !songrequest song-link (Spotify -> Share -> Copy Song Link)`);
                } else {
                    await handleSongRequest(channel, tags[displayNameTag], message, tags, true);
                }
        } else if (currentConfig.allow_volume_set && messageToLower.split(" ")[0] == '!volume') {
            let args = messageToLower.split(" ")[1];
                if (!args) {
                    await handleGetVolume(channel, tags);
                } else {
                    await handleSetVolume(channel, tags, args);
                }
        }
        else if (messageToLower === currentConfig.skip_alias) {
            await handleSkipSong(channel, tags);
        }
        else if (currentConfig.use_song_command && messageToLower === '!song') {
            await handleTrackName(channel);
        }
        else if (currentConfig.use_queue_command && messageToLower === '!queue') {
            await handleQueue(channel);
        }
        else if (currentConfig.allow_vote_skip && messageToLower === '!voteskip' ) {
            await handleVoteSkip(channel, tags[displayNameTag]);
        }
    });
    
    client.on('redeem', async (channel, username, rewardType, tags, message) => {
        log(`Reward ID: ${rewardType}`);
        if(currentConfig.usage_types.includes(channelPointsUsageType) && rewardType === currentConfig.custom_reward_id) {
            let result = await handleSongRequest(channel, tags[displayNameTag], message, tags);
            if(!result) {
                if (await twitchAPI.refundPoints()) {
                    log(`${username} redeemed a song request that couldn't be completed. It was refunded automatically.`);
                } else {
                    log(`${username} redeemed a song request that couldn't be completed. It could not be refunded automatically.`);
                }
            }
            if (result) {
                if(await twitchAPI.fulfillRedemption()){
                    log(`${username} Redemption fulfilled successfully for reward ID ${rewardType}`);
                } else{
                    log(`${username} Redemption Failed to fulfill successfully for reward ID ${rewardType}`);
                }
            }
        }
    });
    
    // Extracted for easier debugging without spending actual bits (can be called from client.on('message'))
    let onCheer = async (channel, state, message) => {
        let bitsParse = parseInt(state.bits);
        let bits = isNaN(bitsParse) ? 0 : bitsParse;
      
        if(currentConfig.usage_types.includes(bitsUsageType)) {
            let use_exact_amount = currentConfig.use_exact_amount_of_bits;
            if(use_exact_amount && bits == currentConfig.minimum_requred_bits || !use_exact_amount && bits >= currentConfig.minimum_requred_bits) {
                let username = state[displayNameTag];
                // afaik, bit redeems include the word "bits" which can mess up the search query.
                // we disassemble the phrase, remove anything with 'cheerX' where X is any number or digit
                // not likely that a lot of songs contain word 'Cheer15' in their names
                message = message.split(' ').filter(w => !(w.includes('cheer') && /\d/.test(w))).join(' '); 
                let result = await handleSongRequest(channel, username, message, true);
                if(!result) {
                console.log(`${username} tried cheering for the song request, but it failed (broken link or something). You will have to add it manually`);
              }
            }
        }
      }
    client.on('cheer', onCheer);
})();

//dashboard setup
//const startDashboardServer = require('./dashboard');
//startDashboardServer();

const validTypes = [channelPointsUsageType, commandUsageType, bitsUsageType]
if(!validTypes.some(type => currentConfig.usage_types.includes(type))) {
    console.log(`Usage type is neither '${channelPointsUsageType}', '${commandUsageType}' nor '${bitsUsageType}', app will not work. Edit your settings in the 'spotipack_config.yaml' file`);
}


const redirectUri = `http://localhost:${expressPort}/callback`;

let parseActualSongUrlFromBigMessage = (message) => {
    const regex = new RegExp(spotifyShareUrlMakerRegex);
    let match = message.match(regex);
    if (match !== null) {
        return match[0];
    } else {
        return null;
    }
}

let parseActualSongUriFromBigMessage = (message) => {
    const regex = new RegExp(`${spotifyShareUriMaker}[^\\s]+`);
    let match = message.match(regex);
    if (match !== null) {
        spotifyIdToUrl = spotifyShareUrlMaker + match[0].split(':')[2];
        return spotifyIdToUrl;
    } else {
        return null;
    }
}

let handleTrackName = async (channel) => {
    try {
        await printTrackName(channel);
    } catch (error) {
        // Token expired
        if(error?.response?.data?.error?.status === 401) {
            await refreshAccessToken();
            await printTrackName(channel);
        } else {
            client.say(currentConfig.channel_name, 'Seems like no music is playing right now');
        }
    }
}

let handleQueue = async (channel) => {
    try {
        await printQueue(channel);
    } catch (error) {
        // Token expired
        if(error?.response?.data?.error?.status === 401) {
            await refreshAccessToken();
            await printQueue(channel);
        } else {
            client.say(currentConfig.channel_name, `Seems like no music is playing right now`);
        }
    }
}

let handleVoteSkip = async (channel, username) => {

    if (!usersHaveSkipped.has(username)) {
        startOrProgressVoteskip(channel);

        usersHaveSkipped.add(username);
        log(`${username} voted to skip the current song (${usersHaveSkipped.size}/${currentConfig.required_vote_skip})!`);
        client.say(channel, `${username} voted to skip the current song (${usersHaveSkipped.size}/${currentConfig.required_vote_skip})!`);
    }
    if (usersHaveSkipped.size >= currentConfig.required_vote_skip) {
        usersHaveSkipped.clear();
        clearTimeout(voteskipTimeout);
        console.log(`Chat has skipped ${await getCurrentTrackName(channel)} (${currentConfig.required_vote_skip}/${currentConfig.required_vote_skip})!`);
        client.say(channel, `Chat has skipped ${await getCurrentTrackName(channel)} (${currentConfig.required_vote_skip}/${currentConfig.required_vote_skip})!`);
        let spotifyHeaders = getSpotifyHeaders();
        res = await axios.post('https://api.spotify.com/v1/me/player/next', {}, { headers: spotifyHeaders });
    }
}

let printTrackName = async (channel) => {
    let spotifyHeaders = getSpotifyHeaders();

    let res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: spotifyHeaders
    });

    let trackId = res.data.item.id;
    let trackInfo = await getTrackInfo(trackId);
    let trackName = trackInfo.name;
    let trackLink = res.data.item.external_urls.spotify;
    let artists = trackInfo.artists.map(artist => artist.name).join(', ');
    client.say(channel, `▶️ ${artists} - ${trackName} -> ${trackLink}`);
}

let getCurrentTrackName = async (channel) => {
    let spotifyHeaders = getSpotifyHeaders();

    let res = await axios.get('https://api.spotify.com/v1/me/player/currently-playing', {
        headers: spotifyHeaders
    });

    let trackId = res.data.item.id;
    let trackInfo = await getTrackInfo(trackId);
    let trackName = trackInfo.name;
    return trackName;
}

let printQueue = async (channel) => {
    let spotifyHeaders = getSpotifyHeaders();

    let res = await axios.get('https://api.spotify.com/v1/me/player/queue', {
        headers: spotifyHeaders
    });

    if (!res.data?.currently_playing || !res.data?.queue){
        client.say(channel, 'Nothing in the queue.')
    }
	else {
		let songIndex = 1;
		let concatQueue = '';
        let queueDepthIndex = currentConfig.queue_display_depth;

        res.data.queue?.every(qItem => {
            let trackName = qItem.name;
            let artists = qItem.artists[0].name;
            concatQueue += `• ${songIndex}) ${artists} - ${trackName} `;

            queueDepthIndex--;
            songIndex++;

            // using 'every' to loop instead of 'foreach' allows us to break out of a loop like this
            // so we can keep it
            if (queueDepthIndex <= 0) {
                return false;
            }
            else {
                return true;
            }
        })

        client.say(channel, `▶️ Next ${currentConfig.queue_display_depth} songs: ${concatQueue}`);
	}
}

let handleSongRequest = async (channel, username, message, tags) => {
    let validatedSongId = await validateSongRequest(message, channel);
    if(!validatedSongId) {
        client.say(channel, currentConfig.song_not_found);
        return false;
    }  else if (currentConfig.use_cooldown && !usersOnCooldown.has(username)) {
        usersOnCooldown.add(username);
        setTimeout(() => {
            usersOnCooldown.delete(username)
        }, cooldownDuration);
    } else if (currentConfig.use_cooldown) {
        client.say(channel, `${username}, Please wait before requesting another song.`);
      return false;
    }

    return await addValidatedSongToQueue(validatedSongId, channel, username, tags);
  }

let addValidatedSongToQueue = async (songId, channel, callerUsername, tags) => {
    try {
        await addSongToQueue(songId, channel, callerUsername, tags);
    } catch (error) {
        // Token expired
        if(error?.response?.data?.error?.status === 401) {
            await refreshAccessToken();
            await addSongToQueue(songId, channel, callerUsername, tags);
        }
        // No action was received from the Spotify user recently, need to print a message to make them poke Spotify
        if(error?.response?.data?.error?.status === 404) {
            client.say(channel, `Hey, ${channel}! You forgot to actually use Spotify this time. Please open it and play some music, then I will be able to add songs to the queue`);
            return false;
        }
        if(error?.response?.data?.error?.status === 400) {
            client.say(channel, currentConfig.song_not_found);
            return false;
        }
        if(error?.response?.status === 403) {
            client.say(channel, `It looks like Spotify doesn't want you to use it for some reason. Check the console for details.`);
            console.log(`Spotify doesn't allow requesting songs because: ${error.response.data.error.message}`);
            return false;
        }
        if(error.message.includes("max") ) {
            log(error.message);
        }
        else {
            console.log('ERROR WHILE REACHING SPOTIFY');
            console.log(error?.response?.data);
            console.log(error?.response?.status);
            return false;
        }
    }

    return true;
}

let searchTrackID = async (searchString) => {
    // Excluding command aliases from the query string
    currentConfig.command_alias.forEach(alias => {
        searchString = searchString.replace(alias, '');
    });

    let spotifyHeaders = getSpotifyHeaders();
    searchString = searchString.replace(/-/, ' ');
    searchString = searchString.replace(/ by /, ' ');
    searchString = encodeURIComponent(searchString);
    const searchResponse = await axios.get(`https://api.spotify.com/v1/search?q=${searchString}&type=track`, {
        headers: spotifyHeaders
    });
    let trackId = searchResponse.data.tracks.items[0]?.id;
    if (currentConfig.blocked_tracks.includes(trackId)) {
        return false;
    } else {
        return trackId;
    }
}

let validateSongRequest = async (message, channel) => {
    // If it contains a link, just use it as is
    if (parseActualSongUrlFromBigMessage(message)) {
        return await getTrackId(parseActualSongUrlFromBigMessage(message));
    } else if (parseActualSongUriFromBigMessage(message)) {
        return await getTrackId(parseActualSongUriFromBigMessage(message));
    } else {
        try {
            return await searchTrackID(message);
        } catch (error) {
            // Token expired
            if(error?.response?.data?.error?.status === 401) {
                await refreshAccessToken();
                await validateSongRequest(message, channel);
            } else {
                return false;
            }
        }
    }
}

let getTrackId = (url) => {
    let trackId = url.split('/').pop().split('?')[0];
    if (currentConfig.blocked_tracks.includes(trackId)) {
        return false;
    } else {
        return trackId;
    }
}

let getTrackInfo = async (trackId) => {
    let spotifyHeaders = getSpotifyHeaders();
    let trackInfo = await axios.get(`https://api.spotify.com/v1/tracks/${trackId}`, {
        headers: spotifyHeaders
    });
    return trackInfo.data;
}

let addSongToQueue = async (songId, channel, callerUsername, tags) => {
    let spotifyHeaders = getSpotifyHeaders();

    let trackInfo = await getTrackInfo(songId);

    let trackName = trackInfo.name;
    let artists = trackInfo.artists.map(artist => artist.name).join(', ');

    let uri = trackInfo.uri;

    let duration = trackInfo.duration_ms / 1000;
    let eligible = isUserEligible(channel, tags, currentConfig.ignore_max_length);

    if (duration > currentConfig.max_duration && !eligible) {
        client.say(channel, `${trackName} is too long. The max duration is ${currentConfig.max_duration} seconds`);
        throw new Error(`${trackName} is too long. The max duration is ${currentConfig.max_duration} seconds`);
    }

    let res = await axios.post(`https://api.spotify.com/v1/me/player/queue?uri=${uri}`, {}, {headers: spotifyHeaders});

    let trackParams = {
        artists: artists,
        trackName: trackName,
        username: callerUsername
    }

    client.say(channel, handleMessageQueries(currentConfig.added_to_queue_messages, trackParams));
}

let refreshAccessToken = async () => {
    const params = new URLSearchParams();
    params.append('refresh_token', spotifyRefreshToken);
    params.append('grant_type', 'refresh_token');
    params.append('redirect_uri', `http://localhost:${expressPort}/callback`);

    try {
        let res = await axios.post('https://accounts.spotify.com/api/token', params, {
            headers: {
                'Content-Type':'application/x-www-form-urlencoded',
                'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64')
            }
        });
        spotifyAccessToken = res.data.access_token;
    } catch (error) {
        console.log(`Error refreshing token: ${error.message}`);
    }
}

function getSpotifyHeaders() {
    return {
        'Authorization': `Bearer ${spotifyAccessToken}`
    };
}

// SPOTIFY CONNECTIONG STUFF
let app = express();

app.get('/login', (req, res) => {
    const scope = 'user-modify-playback-state user-read-playback-state user-read-currently-playing';
    const authParams = new URLSearchParams();
    authParams.append('response_type', 'code');
    authParams.append('client_id', client_id);
    authParams.append('redirect_uri', redirectUri);
    authParams.append('scope', scope);
    res.redirect(`https://accounts.spotify.com/authorize?${authParams}`);
});

app.get('/callback', async (req, res) => {
    let code = req.query.code || null;

    if (!code) {
        // Print error
        return;
    }

    const params = new URLSearchParams();
    params.append('code', code);
    params.append('redirect_uri', redirectUri);
    params.append('grant_type', 'authorization_code');

    const config = {
        headers: {
            'Authorization': 'Basic ' + Buffer.from(client_id + ':' + client_secret).toString('base64'),
            'Content-Type':'application/x-www-form-urlencoded'
        }
    };

    let tokenResponse = await axios.post('https://accounts.spotify.com/api/token', params, config);

    if (!tokenResponse.statusCode === 200) {
        // Print error
        return;
    }

    spotifyAccessToken = tokenResponse.data.access_token;
    spotifyRefreshToken = tokenResponse.data.refresh_token;

    res.send('Tokens refreshed successfully. You can close this tab');
});

app.get('/now-playing', async (req, res) => {
    const track = await getCurrentTrack();
    res.send(`
      <html>
        <head>
          <style>
            body { margin: 0; font-family: sans-serif; background: transparent; color: white; }
            .track { font-size: 24px; padding: 10px; background: rgba(0,0,0,0.6); border-radius: 10px; }
          </style>
        </head>
        <body>
          <div class="track">${track || 'Nothing playing right now'}</div>
        </body>
      </html>
    `);
  });


app.listen(expressPort);

console.log(`Now Playing overlay at http://localhost:${expressPort}/now-playing`);
console.log(`App is running. Visit http://localhost:${expressPort}/login to refresh the tokens if the page didn't open automatically`);
open(`http://localhost:${expressPort}/login`);
//open('http://localhost:3002');
/**
 * Reads the configuration file and checks if it is valid.
 * @returns {object} The configuration object from the yaml file
 */
function setupYamlConfigs () {
    const configFile = fs.readFileSync('spotipack_config.yaml', 'utf8');
    let fileConfig = YAML.parse(configFile);

    fileConfig = checkIfSetupIsCorrect(fileConfig);

    return fileConfig;
}
function reloadConfig() {
    currentConfig = setupYamlConfigs();
    // Optional: reinitialize any components using the new config
    if (global.twitchController) {
        global.twitchController.init(currentConfig, global.token, global.clientId); // reuse init params
    }
    console.log("🔁 Config reloaded");
}

module.exports = {
    currentConfig,
    reloadConfig
};


/**
 * If voteskip is enabled, starts or progresses the voteskip timer.
 * If someone has already voted to skip, the timer is cleared and the timeout is reset to the timeout specified in the config file.
 * @param {string} channel - The channel to start or progress the voteskip in.
 */
function startOrProgressVoteskip(channel) {
    if (usersHaveSkipped.size > 0) {
        clearTimeout(voteskipTimeout);
    }

    voteskipTimeout = setTimeout(function() {resetVoteskip(channel)}, currentConfig.voteskip_timeout * 1000);
}

/**
 * Resets the voteskip process for a given channel.
 * Sends a message indicating that the voteskip has timed out and clears the list of users who have voted to skip.
 *
 * @param {string} channel - The channel where the voteskip is being reset.
 */

function resetVoteskip(channel) {
    client.say(channel, `Voteskip has timed out... No song will be skipped at this time! catJAM`);
    usersHaveSkipped.clear();
}




/**
 * Validates the setup configuration for the chatbot.
 *
 * This function checks the usage types specified in the configuration and ensures that
 * necessary parameters are provided. If 'channel_points' is included in 'usage_types',
 * a custom Reward ID must be set. If 'command' is included, at least one command alias
 * must be provided. It also normalizes the command aliases to lowercase.
 *
 * @param {object} fileConfig - The configuration object from the YAML file.
 * @returns {object} The validated and possibly modified configuration object.
 */

function checkIfSetupIsCorrect(fileConfig) {
    if (fileConfig.usage_types.includes(channelPointsUsageType) && fileConfig.custom_reward_id === defaultRewardId) {
        console.log(`!ERROR!: You have included 'channel_points' in 'usage_types', but didn't provide a custom Reward ID. Refer to the manual to get the Reward ID value, or change the usage type`);
    }
    // check if we have any aliases if we are using commands
    if (fileConfig.usage_types.includes(commandUsageType) && fileConfig.command_alias.length === 0) {
        console.log(`!ERROR!: You have included 'command' in 'usage_types', but didn't provide any command aliases. Please add an alias to be able to request songs`);
    }
    else {
        for (let i = 0; i < fileConfig.command_alias.length - 1; i++) {
            fileConfig.command_alias[i] = fileConfig.command_alias[i].toLowerCase();
        }
    }
    return fileConfig;
}
/**
 * Given an array of messages and an object of parameters, this function
 * randomly selects one of the messages and replaces placeholders with
 * the corresponding values from the parameters object.
 *
 * Supported placeholders are:
 * - $(username)
 * - $(trackName)
 * - $(artists)
 *
 * @param {string[]} messages - Array of messages to choose from.
 * @param {object} params - Object containing the values to replace the placeholders with.
 * @returns {string} The final message with placeholders replaced.
 */

/**
 * Given an array of messages and an object of parameters, this function
 * randomly selects one of the messages and replaces placeholders with
 * the corresponding values from the parameters object.
 *
 * Supported placeholders are:
 * - $(username)
 * - $(trackName)
 * - $(artists)
 *
 * @param {string[]} messages - Array of messages to choose from.
 * @param {object} params - Object containing the values to replace the placeholders with.
 * @returns {string} The final message with placeholders replaced.
 */
function handleMessageQueries (messages, params) {
    let newMessage = messages[Math.floor(Math.random() * messages.length)];

    if (params.username) {
        newMessage = newMessage.replace('$(username)', params.username);
    }
    if (params.trackName) {
        newMessage = newMessage.replace('$(trackName)', params.trackName);
    }
    if (params.artists) {
        newMessage = newMessage.replace('$(artists)', params.artists);
    }

    return newMessage;
}

/**
 * Logs a message to the console if the logs option is enabled in the configuration.
 *
 * @param {string} message - The message to log.
 */
function log(message) {
    if(currentConfig.logs) {
        console.log(message);
    }
}

/**
 * Checks if the given user is eligible for a song request given their roles.
 *
 * @param {string} channel - The channel name to check.
 * @param {object} tags - The user's tags.
 * @param {string[]} rolesArray - Roles to check the user against.
 * @returns {boolean} Whether the user is eligible to request a song.
 */
function isUserEligible(channel, tags, rolesArray) {
    const username = tags.username;
    const channelName = channel.replace('#', '');

    log(`Checking user: ${username}`);
    log(`Tags: ${JSON.stringify(tags)}`);
    log(`Roles to check: ${rolesArray}`);

    const roleChecks = [
        { check: tags.badges?.broadcaster === '1' || username === channelName, role: streamer },
        { check: tags.mod === true || tags.mod === '1', role: mod },
        { check: tags.badges?.vip === '1', role: vip },
        { check: tags.badges?.subscriber === '1' || tags['badge-info']?.subscriber, role: sub },
        { check: true, role: everyone },
    ];

    return roleChecks.some(({ check, role }) => check && rolesArray.includes(role));
}

async function handleSkipSong(channel, tags) {
    try {
        let eligible = isUserEligible(channel, tags, currentConfig.skip_user_level);

        if(eligible) {
            client.say(channel, `${tags[displayNameTag]} skipped ${await getCurrentTrackName(channel)}!`);
            log(`${tags[displayNameTag]} skipped ${await getCurrentTrackName(channel)}!`);
            let spotifyHeaders = getSpotifyHeaders();
            res = await axios.post('https://api.spotify.com/v1/me/player/next', null, { headers: spotifyHeaders });
        }
    } catch (error) {
        console.log(error);
        // Skipping the error for now, let the users spam it
        // 403 error of not having premium is the same as with the request,
        // ^ TODO get one place to handle common Spotify error codes
    }
}

async function handleGetVolume(channel, tags) {
    try {
        let eligible = isUserEligible(channel, tags, currentConfig.volume_set_level);

        if(eligible) {
            let spotifyHeaders = getSpotifyHeaders();
            res = await axios.get('https://api.spotify.com/v1/me/player', { headers: spotifyHeaders });

            let currVolume = res.data.device.volume_percent;
            log(`${tags[displayNameTag]}, the current volume is ${currVolume.toString()}!`);
            client.say(channel, `${tags[displayNameTag]}, the current volume is ${currVolume.toString()}!`);
        }
    } catch (error) {
        console.log(error);
        // Skipping the error for now, let the users spam it
        // 403 error of not having premium is the same as with the request,
        // ^ TODO get one place to handle common Spotify error codes
    }
}

async function handleSetVolume(channel, tags, arg) {

    try {
        let eligible = isUserEligible(channel, tags, currentConfig.volume_set_level);

        if(eligible) {

            let number = 0;
            try {
                number = Number(arg);
                number = clamp(number, volMin, volMax);
            } catch (error) {
                console.log(error);
                client.say(channel, `${tags[displayNameTag]}, a number between 0 and 100 is required.`);
                return;
            }

            let spotifyHeaders = getSpotifyHeaders();
            //courtesy of greav
            res = await axios.put('https://api.spotify.com/v1/me/player/volume', null, { headers: spotifyHeaders, params:{volume_percent: number} });

            log(`${tags[displayNameTag]} has set the current volume to ${number.toString()}!`);
            client.say(channel, `${tags[displayNameTag]} has set the current volume to ${number.toString()}!`);
        }
    } catch (error) {
        console.log(error);
        client.say(channel, `There was a problem setting the volume`);
        // Skipping the error for now, let the users spam it
        // 403 error of not having premium is the same as with the request,
        // ^ TODO get one place to handle common Spotify error codes
    }
}
