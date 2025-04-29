const axios = require('axios').default;
const { ToadScheduler, SimpleIntervalJob, AsyncTask } = require('toad-scheduler');
const express = require('express');
const fs = require('fs');
const path = require('path');
const open = require('open');

module.exports = class Twitch {
    reward_id; // custom reward id
    broadcaster_id; // broadcaster id needed for many api calls
    scheduler; // scheduler, validates our token hourly
    token;
    client_id;
    refunds_active; // false if refunds are disabled due to an error or by config file

    TOKEN_FILE = path.join(__dirname, 'twitch_token.json');
    CLIENT_ID = process.env.TWITCH_CLIENT_ID;
    CLIENT_SECRET = process.env.TWITCH_CLIENT_SECRET;
    REDIRECT_URI = 'http://localhost:3000/callback';
    
    constructor() {
        this.refunds_active = true;
    }

    /**
     * Async constructor
     * @param chatbotConfig - settings
     * @param token - twitch oauth token
     * @param id - twitch client id
     */
    async init(chatbotConfig, token = null, id = null) {
    this.client_id = id || this.CLIENT_ID;

    // Try passed token or fallback to saved token
    this.token = token || this.getSavedToken();

    if (!this.token) {
        console.log("No saved token found, starting OAuth flow...");
        await this.startOAuthServer();
        this.token = this.getSavedToken();  // Retrieve token saved by startOAuthServer
    } else {
        console.log("Loaded saved Twitch token.");
    }

    this.broadcaster_id = await this.getBroadcasterId(chatbotConfig.channel_name);

    // === Handle Refunds ===
    if (!chatbotConfig.automatic_refunds) {
        this.refunds_active = false;
        this.reward_id = chatbotConfig.custom_reward_id;
        return;
    }

    if (!this.client_id || !this.token) {
        console.error("Missing client_id or token. Refunds disabled.");
        this.refunds_active = false;
        this.reward_id = chatbotConfig.custom_reward_id;
        return;
    }

    // Set up token validation job
    this.scheduler = new ToadScheduler();
    const validateTask = new AsyncTask('ValidateTwitchToken', async () => {
        await this.validateTwitchToken();
    });
    const validateJob = new SimpleIntervalJob({ hours: 1, runImmediately: true }, validateTask);
    this.scheduler.addSimpleIntervalJob(validateJob);

    // Validate token and check reward
    if (!this.refunds_active) {
        console.error("Refunds were enabled, but token validation failed.");
        this.reward_id = chatbotConfig.custom_reward_id;
        return;
    }

    await this.checkRewardExistence(chatbotConfig);
}


/**
 * Starts a local Express server to handle the OAuth flow for Twitch authentication.
 * 
 * This server listens on port 3000 and provides two endpoints:
 * 1. `/login`: Redirects the user to the Twitch OAuth authorization page for user authentication.
 * 2. `/callback`: Handles the OAuth callback with the authorization code, exchanges it for an access token,
 *    and saves the token data to a file for future use. Closes the server after completing the flow.
 * 
 * The function returns a Promise that resolves with the access token upon successful authentication,
 * or rejects with an error if the OAuth process fails.
 */

    startOAuthServer() {
        return new Promise((resolve, reject) => {
            const app = express();
    
            app.get('/login', (req, res) => {
                const scope = 'channel:read:redemptions channel:manage:redemptions user:read:email chat:read chat:edit';
                const authUrl = `https://id.twitch.tv/oauth2/authorize?client_id=${this.CLIENT_ID}&redirect_uri=${encodeURIComponent(this.REDIRECT_URI)}&response_type=code&scope=${encodeURIComponent(scope)}`;
                res.redirect(authUrl);
            });
    
            app.get('/callback', async (req, res) => {
                const code = req.query.code;
                try {
                    const tokenRes = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                        params: {
                            client_id: this.CLIENT_ID,
                            client_secret: this.CLIENT_SECRET,
                            code,
                            grant_type: 'authorization_code',
                            redirect_uri: this.REDIRECT_URI
                        }
                    });
                    fs.writeFileSync(this.TOKEN_FILE, JSON.stringify(tokenRes.data, null, 2));
                    console.log("Twitch token saved to file.");
                    this.token = tokenRes.data.access_token;
                    res.send("Twitch OAuth complete. You may now close this tab.");
                    server.close(() => resolve(this.token));
                } catch (err) {
                    console.error("OAuth error:", err.response?.data || err.message);
                    res.status(500).send("OAuth failed");
                    server.close(() => reject(err));
                }
            });
    
            const server = app.listen(3000, () => {
                open(`http://localhost:3000/login`);
                console.log("No token found. Please authenticate at: http://localhost:3000/login  if the page didn't open automatically.");
            });
        });
    }
    
    getSavedToken() {
        if (fs.existsSync(this.TOKEN_FILE)) {
            const data = JSON.parse(fs.readFileSync(this.TOKEN_FILE));
            this.token = data.access_token;
            return this.token;
            console.log(`token: ${this.token}`);
        }
        return false;
    }
    
/**
 * Refreshes the Twitch access token using the refresh token stored in a file.
 * 
 * This function checks if the token file exists and reads the refresh token from it.
 * It then makes a POST request to the Twitch OAuth endpoint to get a new access token.
 * If successful, it updates the internal access token state and writes the new token
 * data back to the file. If refreshing fails, it logs the error and returns false.
 * 
 * @returns {Promise<boolean>} Resolves to true if the token was refreshed successfully, otherwise false.
 */

    async refreshAccessToken() {
        if (!fs.existsSync(this.TOKEN_FILE)) {
            console.error("No refresh token available.");
            return false;
        }
    
        const tokenData = JSON.parse(fs.readFileSync(this.TOKEN_FILE));
        if (!tokenData.refresh_token) {
            console.error("Refresh token missing from token file.");
            return false;
        }
    
        try {
            const res = await axios.post('https://id.twitch.tv/oauth2/token', null, {
                params: {
                    grant_type: 'refresh_token',
                    refresh_token: tokenData.refresh_token,
                    client_id: this.CLIENT_ID,
                    client_secret: this.CLIENT_SECRET
                }
            });
    
            this.token = res.data.access_token;
    
            // Save updated tokens to file
            fs.writeFileSync(this.TOKEN_FILE, JSON.stringify(res.data, null, 2));
            console.log("Access token refreshed successfully.");
            return true;
        } catch (err) {
            console.error("Failed to refresh access token:", err.response?.data || err.message);
            return false;
        }
    }
    
    /**
     * Formats auth headers
     * @returns {{Authorization: string, "Client-ID": string}}
     */
    getTwitchHeaders() {
        console.log(`token: ${this.token}`);
        return {
            'Authorization': `Bearer ${this.token}`,
            'Client-ID': this.client_id
        };
    }

    /**
     * Check if we have created a reward in a past session. If so, we will use that reward.
     * Otherwise we will create a new reward.
     * @param chatbotConfig - for settings in order to create a new reward
     */
    async checkRewardExistence(chatbotConfig) {
        try {
            let res = await axios.get('https://api.twitch.tv/helix/channel_points/custom_rewards', {
                params: {
                    'broadcaster_id': this.broadcaster_id,
                    'only_manageable_rewards': true
                },
                headers: this.getTwitchHeaders()
            });
            if (res.data.data.length === 0) {
                await this.createReward(chatbotConfig.custom_reward_name, chatbotConfig.custom_reward_cost);
            }
            else {
                this.reward_id = res.data.data[0].id;
            }
        } catch (error) {
            console.error(error);
        }
    }

/**
 * Validates the current Twitch OAuth token.
 * Attempts to verify the token by making a GET request to the Twitch validation endpoint.
 * If the token is invalid, it tries to refresh the token. If refreshing fails, it disables refunds but keeps the chat active.
 * Checks if the token has the necessary scope for managing redemptions. If not, disables refunds.
 * Updates the `refunds_active` state based on the validation results.
 * Logs relevant information and errors during the process.
 */
    async validateTwitchToken() {
        try {
            let res = await axios.get('https://id.twitch.tv/oauth2/validate', {
                headers: { 'Authorization': `OAuth ${this.token}` },
                validateStatus: (status) => [200, 401].includes(status)
            });
    
            if (res.status === 401) {
                console.warn('[Twitch] Token invalid, attempting refresh...');
                const refreshed = await this.refreshAccessToken();
    
                if (!refreshed) {
                    console.error('[Twitch] Token refresh failed. Refunds will be disabled, but chat will remain active.');
                    this.refunds_active = false;
                    return;
                }
    
                // Revalidate with new token
                return await this.validateTwitchToken();
            }
    
            if (res.status === 200 && !res.data['scopes'].includes('channel:manage:redemptions')) {
                console.warn('[Twitch] Token is valid, but missing "channel:manage:redemptions". Refunds disabled.');
                this.refunds_active = false;
            } else {
                this.refunds_active = true;
            }
    
        } catch (error) {
            console.error('[Twitch] Token validation error:', error);
            this.refunds_active = false;
        }
    }
    
    

    /**
     * Validate our OAuth token. If this fails, it will prepare to fallback to the refundless program
     */
    async validateTwitchTokenOld() {
        try {
            let res = await axios.get('https://id.twitch.tv/oauth2/validate', {
                headers: { 'Authorization': `OAuth ${this.token}` },
                validateStatus: function (status) {
                    return [401, 200].includes(status);
                }
            })
            if (res.status === 401) {
                console.error('Twitch token validation failed. Have you revoked the token?');
                console.error('Refunds will not work.');
                this.scheduler.stop();
            } else if (res.status === 200 && !res.data['scopes'].includes('channel:manage:redemptions')) {
                console.error('For refunds to work, please make sure to add "channel:manage:redemptions" to the OAuth scopes.');
                this.scheduler.stop();
            }
        } catch (error) {
            this.refunds_active = false;
            console.error(error);
        }
    }

    /**
     * Refunds points, returns true is successful, false otherwise.
     * @returns {Promise<boolean>}
     */
    async refundPoints() {
        // refunds not activated.
        if (!this.refunds_active) { return false; }
        try {
            let id = await this.getLastRedemptionId();
            if (id === null) { return false; }
            await axios.patch(`https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions`,
                { 'status': 'CANCELED' },
                {
                    params: {
                        'id': id,
                        'broadcaster_id': this.broadcaster_id,
                        'reward_id': this.reward_id
                    },
                    headers: this.getTwitchHeaders()
                });
            return true;
        } catch (error) {
            return false;
        }

    }

    /**
     * Completes Point Redemption, returns true if successful, false otherwise.
     * @returns {Promise<boolean>}
     */
    async fulfillRedemption() {
        try {
            let id = await this.getLastRedemptionId();
            if (id === null) { return false; }
            await axios.patch(`https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions`,
                { 'status': 'FULFILLED' },
                {
                    params: {
                        'id': id,
                        'broadcaster_id': this.broadcaster_id,
                        'reward_id': this.reward_id
                    },
                    headers: this.getTwitchHeaders()
                });
            return true;
        } catch (error) {
            return false;
        }

    }

    /**
     * Creates a new channel point reward
     * @param name - name of the new reward
     * @param cost - cost of the new reward
     */
    async createReward(name, cost) {
        try {
            let res = await axios.post('https://api.twitch.tv/helix/channel_points/custom_rewards',
                {
                    'title': name,
                    'cost': parseInt(cost),
                    'is_user_input_required': true
                },
                {
                    params: { 'broadcaster_id': this.broadcaster_id },
                    headers: this.getTwitchHeaders()
                });
            this.reward_id = res.data.data.id;
        } catch (error) {
            console.error(error);
        }
    }

    /**
     * Gets current broadcaster_id from channel_name
     * @param broadcaster_name
     */
    async getBroadcasterId(broadcaster_name) {
        try {
            let res = await axios.get('https://api.twitch.tv/helix/users',
                {
                    params: { 'login': broadcaster_name },
                    headers: this.getTwitchHeaders(),
                    validateStatus: function (status) {
                        return status < 500;
                    }
                });
            if (res.status === 200) {
                return res.data.data[0].id;
            }
            // this is fatal and many parts will not work without this, means twitch oauth is broken
            console.error("Failed to get broadcaster ID!");
            console.error("This likely means your OAuth token is invalid. Please check your token. If this error persists, contact devs.");
        } catch (error) {
            console.error(error);
        }
    }

    /**
     * Gets the id of the last redemption for use in refundPoints()
     * @returns {Promise<string>}
     */
    async getLastRedemptionId() {
        try {
            let res = await axios.get('https://api.twitch.tv/helix/channel_points/custom_rewards/redemptions', {
                params: {
                    'broadcaster_id': this.broadcaster_id,
                    'reward_id': this.reward_id,
                    'status': 'UNFULFILLED',
                    'sort': 'NEWEST',
                    'first': 1
                },
                headers: this.getTwitchHeaders()
            });
            // Check that the returned array isn't empty
            if (res.data.data.length === 0) {
                console.error(`The redemptions array was empty. ` +
                    `Please make sure that you have not enabled 'skip redemption requests queue.'`);
                return null;
            }
            // If the last redeemed ID was over a minute ago, something is wrong.
            if (Date.now() - Date.parse(res.data.data[0].redeemed_at) > 60_000) {
                console.error(`The latest reward was redeemed over a minute ago. Please contact the devs.`);
                return null;
            }
            return res.data.data[0].id;
        } catch (error) {
            console.error(error);
        }

    }
}
