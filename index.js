import fs from 'node:fs';
import { access } from 'node:fs/promises';
import jsonfile from 'jsonfile';
import express from 'express';
import bodyParser from 'body-parser';
import Imap from 'imap';
import vrchat from 'vrchat';

const CONFIG = jsonfile.readFileSync('config.json');

const PORT = CONFIG.port || 10987;
const DATAPATH = 'datafile.json';
const FAVPATH = 'favorites.json';
const MAX_VOTES = CONFIG.maxVotes || 10;

const ALLOW_VOTING = !CONFIG.closed;

const IMAPCONFIG = {
    user: CONFIG.imapUser,
    password: CONFIG.imapPassword,
    host: CONFIG.imapHost || "localhost",
    port: CONFIG.imapPort || 143,
    tls: CONFIG.imapTls || false,
    autotls: "always",
    tlsOptions: {
        rejectUnauthorized: false
    }
};

const VRCONFIG = new vrchat.Configuration({
    username: CONFIG.username,
    password: CONFIG.password
});
    
const VROPTIONS = {
    localAddress: CONFIG.localAddress,
    headers: { "User-Agent": "WorldVoter/1.0 " + CONFIG.agentEmailAddress }
};

const MAIL_FROM = /(^|<)noreply@vrchat.com(>|$)/;
const MAIL_OTP = /Your One-Time Code is ([0-9]+)/;
const MAIL_TIMEOUT = 60;

const VRGROUP = CONFIG.group;  //VRChat group

const VRChatAuthentication = new vrchat.AuthenticationApi(VRCONFIG);
const VRChatUsers = new vrchat.UsersApi(VRCONFIG);
const VRChatGroups = new vrchat.GroupsApi(VRCONFIG);
const VRChatWorlds = new vrchat.WorldsApi(VRCONFIG);


//Data storage

async function saveData(path, data) {

    return jsonfile.writeFile(path, data, {
        spaces: 4,
        replacer: (key, value) => typeof value === 'bigint' ? value.toString() : value
    });
}

async function loadData(path, def) {

    let contents = (def !== undefined ? def : {});
    
    try {
        await access(path, fs.constants.F_OK );
    } catch (err) {
        await jsonfile.writeFile(path, contents);
    }

    try {
        contents = await jsonfile.readFile(path);
    } catch (err) {
        console.error("Unable to load data:", err.message);
        return;
    }

    Object.defineProperty(contents, 'save', {
        value: () => saveData(path, contents)
    });

    return contents;
}


//IMAP

async function setupImapConnection() {

    const imap = new Imap(IMAPCONFIG);
    const mailReaders = [];
    let mtimer = null;

    return new Promise((resolve, reject) => {
        imap.once('ready', () => {

            imap.openBox('INBOX', false, (err, mailbox) => {

                if (err) {
                    reject(err);
                    return;
                }

                imap.on('mail', (amount) => {
                    const fetch = imap.seq.fetch(`${mailbox.messages.total - amount + 1}:*`, {
                        bodies: 'HEADER.FIELDS (FROM SUBJECT)',
                        markSeen: true
                    });
                    fetch.on('message', (message) => {

                        message.on('body', (stream) => {
                            let buffer = '';
                            stream.on('data', (chunk) => {
                                buffer += chunk.toString('utf8');
                            });
                            stream.once('end', () => {
                                let headers = Imap.parseHeader(buffer);
                                for (let key in headers) {
                                    headers[key] = headers[key][0];
                                }

                                console.log("An e-mail has arrived:" + JSON.stringify(headers));

                                const now = Math.floor(new Date().getTime() / 1000);

                                for (let i = 0; i < mailReaders.length; i++) {
                                    let mailReader = mailReaders[i];
                                    if (mailReader.expires <= now) continue;
                                    if (!mailReader.subjectFilter.exec(headers.subject)) continue;
                                    mailReader.callback(headers, mailReader);
                                    mailReaders.splice(i, 1);
                                }

                            });
                        });

                    });
                });

                resolve({imap, mailReaders, mtimer});
            });

            mtimer = setInterval(() => {

                const now = Math.floor(new Date().getTime() / 1000);

                for (let i = 0; i < mailReaders.length; i++) {
                    let mailReader = mailReaders[i];
                    if (mailReader.expires <= now) {
                        if (mailReader.expiredCallback) {
                            mailReader.expiredCallback(mailReader);
                        }
                        mailReaders.splice(i, 1);
                        i -= 1;
                    }
                }

            }, 5000);
            
        });

        imap.connect();
    });
}


//Actual service

(async function main() {

    //Initialize data

    const data = await loadData(DATAPATH);
    const favorites = await jsonfile.readFile(FAVPATH);

    favorites.name = CONFIG.name;
    if (favorites.serverid) { delete favorites.serverid; }
    if (favorites.channelid) { delete favorites.channelid; }
    if (favorites.channelname) { delete favorites.channelname; }

    favorites.maxVotes = MAX_VOTES;
    favorites.isClosed = !ALLOW_VOTING;

    //IMAP connection

    let imapConnection;
    try {
        imapConnection = await setupImapConnection();
    } catch (err) {
        console.error("Failed to connect to IMAP server:", err);
        return;
    }
    
    //VRChat connection

    let currentUser;
    try {
        currentUser = await VRChatAuthentication.getCurrentUser(VROPTIONS);
        currentUser = currentUser?.data;

        if (!currentUser) {
            throw "Failed to connect to API.";
        }

        if (currentUser["requiresTwoFactorAuth"] && currentUser["requiresTwoFactorAuth"][0] === "emailOtp") {

            console.log("Waiting for VRChat e-mail OTP.");

            await new Promise((resolve, reject) => {
                imapConnection.mailReaders.push({
                    subjectFilter: MAIL_OTP,
                    callback: (headers) => {
                        if (!headers.from.match(MAIL_FROM)) return;
                        const extract = headers.subject.match(MAIL_OTP);
                        
                        VRChatAuthentication.verify2FAEmailCode({ code: extract[1] }, VROPTIONS)
                            .then(() => VRChatAuthentication.getCurrentUser(VROPTIONS))
                            .then((result) => {
                                currentUser = result.data;
                                resolve();
                            });
                    },
                    expires: Math.floor(new Date().getTime() / 1000) + MAIL_TIMEOUT,
                    expiredCallback: () => reject("Timeout before receiving OTP e-mail.")
                });
            });

        }

    } catch (err) {
        console.error("Failed to authenticate with VRChat:", err);
        return;
    }

    process.on("SIGINT", () => {
        VRChatAuthentication.logout(VROPTIONS)
            .then(() => {
                console.log("Logged out from VRChat.");
            })
            .catch((e) => {
                console.log("error", "Unable to log out from VRChat:", e);
            })
            .finally(() => {
                process.exit();
            });
    });
    

    //Endpoints
    
    const app = express();

    app.set('trust proxy', true);

    app.use(bodyParser.json());

    app.get("/worlds", async (req, res) => {
    
        res.status(200).send(favorites);

    });

    app.post("/vote", async (req, res) => {
        //Register someone's votes
        
        try {

            if (!ALLOW_VOTING) {
                return res.status(403).send("Voting is currently closed.");
            }

            if (!req.body.username || !req.body.votes || !Array.isArray(req.body.votes)) {
                return res.status(400).send('Invalid request format.');
            }
            
            let user = req.body.username;
            if (!user.match(/^usr_[0-9a-f-]+$/)) {
                const searchusers = await VRChatUsers.searchUsers(user, undefined, 10, 0, VROPTIONS);
                if (searchusers?.data) {
                    for (let checkuser of searchusers.data) {
                        if (checkuser.displayName === user) {
                            user = checkuser.id;
                            break;
                        }
                    }
                } 
                
                if (!user.match(/^usr_[0-9a-f-]+$/)) {
                    return res.status(400).send("That VRChat username does not exist! If you're having trouble providing your username, you can also use your user ID (starts with usr_ ).");
                }
            }

            const member = await VRChatGroups.getGroupMember(VRGROUP, user, VROPTIONS);
            if (!member?.data) {
                return res.status(403).send("You are not a member of our group! Are you sure that's the right username? If you're having trouble providing your username, you can also use your user ID (starts with usr_ ).");
            }
            
            if (data[user]) {
                return res.status(409).send('You had already voted!');
            }
            
            if (req.body.discord) {
                if (!req.body.discord.match(/^[a-z0-9._]{2,32}$/)) {
                    return res.status(400).send("Invalid Discord username " + req.body.discord + " (make sure you provide your username, not your display name).");
                }
            }
            
            const votes = req.body.votes;
            
            if (votes.length < 1) {
                return res.status(400).send('Amount of votes sent must be at least 1');
            }

            if (votes.length > MAX_VOTES) {
                return res.status(400).send('Amount of votes sent exceeds the maximum of ' + MAX_VOTES);
            }
            
            for (const vote of votes) {
                
                if (!vote.match(/^wrld_[0-9a-f-]+$/)) {
                    return res.status(400).send('Invalid world ID ' + vote);
                }

                if (!favorites.favorites.find(fav => fav.wi === vote)) {
                    return res.status(400).send('World ID ' + vote + ' is not eligible.');
                }

            }
            
            data[user] = {
                user,
                ts: Math.floor(new Date().getTime() / 1000),
                discord: req.body.discord,
                ip: req.ip,
                votes
            };
            data.save();
            
            res.status(200).send('Ballot accepted.');
        
        } catch (err) {
            console.error(err);
            res.status(500).send('There was an error processing your request.');
        }
    });

    app.get("/tally", async (req, res) => {
        //List vote results

        if (!CONFIG.adminPassword || req.query["adminPassword"] !== CONFIG.adminPassword) {
            return res.status(403).send('Forbidden');
        }

        const result = {
            tally: [],  //{world, name, votes}, ...
            voters: {},  //user: {user, name, ts, discord, ip, votes}, ...
            ipcheck: {}  //ip: [{user, name, ts, discord}, ...], ...
        };

        const tally = {};
        const iptally = {};

        //Scan users from submitted votes

        for (const user in data) {

            //Prepare voter information

            const userdata = await VRChatUsers.getUser(user, VROPTIONS);
            if (!userdata?.data) continue;

            const ip = data[user].ip;

            const voter = {
                user,
                name: userdata.data.displayName,
                ts: data[user].ts,
                discord: data[user].discord,
                votes: data[user].votes.length
            }
            
            result.voters[user] = voter;

            if (!iptally[ip]) {
                iptally[ip] = [];
            };

            iptally[ip].push({user: voter.user, name: voter.name, ts: voter.ts, discord: voter.discord});

            //Tally votes per world

            for (const world of data[user].votes) {

                if (!tally[world]) {
                    
                    const worlddata = await VRChatWorlds.getWorld(world, VROPTIONS);

                    tally[world] = {
                        name: worlddata.data?.name || "(World removed)",
                        votes: 1
                    }

                } else {

                    tally[world].votes += 1;

                }

            }

        }

        //Convert tally to sorted list

        for (const world in tally) {
            result.tally.push({world, ...tally[world]});
        }

        result.tally.sort((a, b) => b.votes - a.votes);

        //IP alerts

        for (const ip in iptally) {
            if (iptally[ip].length < 2) { continue; }
            result.ipcheck[ip] = iptally[ip];
        }

        res.status(200).send(result);

    });

    app.listen(PORT, () => {
        console.log("Vote backend is running on port", PORT);
    });
    
})();
