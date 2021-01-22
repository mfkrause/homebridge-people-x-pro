const storage = require('node-persist');
const http = require('http');
const url = require('url');

const PeopleProAccessory = require('./accessory');
const PeopleProAllAccessory = require('./all_accessory');

let homebridge;

class PeopleProPlatform {
  constructor(log, config) {
    this.log = log;
    this.config = config;
    this.threshold = config.threshold || 15;
    this.anyoneSensor = ((typeof (config.anyoneSensor) !== 'undefined' && config.anyoneSensor !== null) ? config.anyoneSensor : true);
    this.nooneSensor = ((typeof (config.nooneSensor) !== 'undefined' && config.nooneSensor !== null) ? config.nooneSensor : false);
    this.anyoneSensorName = config.anyoneSensorName || 'Anyone';
    this.nooneSensorName = config.nooneSensorName || 'No One';
    this.webhookPort = config.webhookPort || 51828;
    this.webhookEnabled = ((typeof (config.webhookEnabled) !== 'undefined' && config.webhookEnabled !== null) ? config.webhookEnabled : false);
    this.pingInterval = config.pingInterval || 10000;
    this.ignoreWebhookReEnter = config.ignoreWebhookReEnter || 0;
    this.people = config.people;
    this.storage = storage;
    this.storage.initSync({ dir: `${homebridge.user.storagePath()}/plugin-persist/homebridge-people-pro` });
    this.webhookQueue = [];
  }

  accessories(callback) {
    this.accessories = [];
    this.peopleProAccessories = [];

    // Get all people / targets and add them to accessories
    for (let i = 0; i < this.people.length; i += 1) {
      const peopleProAccessory = new PeopleProAccessory(this.log, this.people[i], this);
      this.accessories.push(peopleProAccessory);
      this.peopleProAccessories.push(peopleProAccessory);
    }

    // Add "anyone" and "no one" sensors / accessories
    if (this.anyoneSensor) {
      this.peopleAnyOneAccessory = new PeopleProAllAccessory(
        this.log, this.config, this.anyoneSensorName, this, 'anyone',
      );
      this.accessories.push(this.peopleAnyOneAccessory);
    }
    if (this.nooneSensor) {
      this.peopleNoOneAccessory = new PeopleProAllAccessory(
        this.log, this.config, this.nooneSensorName, this, 'noone',
      );
      this.accessories.push(this.peopleNoOneAccessory);
    }
    callback(this.accessories);

    // Start webhook server if enabled
    if (this.webhookEnabled) {
      this.startServer();
    }
  }

  /**
   *  Spins up a webserver for the webhook functionality.
   *
   *  HTTP webserver code influenced by benzman81's great homebridge-http-webhooks plugin:
   *  https://github.com/benzman81/homebridge-http-webhooks
   */
  startServer() {
    http.createServer(((request, response) => {
      const theUrl = request.url;
      const theUrlParts = url.parse(theUrl, true);
      const theUrlParams = theUrlParts.query;
      let body = [];
      request.on('error', ((err) => {
        this.log('Webhook error: %s.', err);
      })).on('data', (chunk) => {
        body.push(chunk);
      }).on('end', (() => {
        body = Buffer.concat(body).toString();

        response.on('error', (err) => {
          this.log('Webhook error: %s.', err);
        });

        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');

        if (!theUrlParams.sensor || !theUrlParams.state) {
          // Received invalid request
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain');
          const errorText = 'Webhook error: No sensor or state specified in request.';
          this.log(errorText);
          response.write(errorText);
          response.end();
        } else {
          const sensor = theUrlParams.sensor.toLowerCase();
          const newState = (theUrlParams.state === 'true');
          this.log(`Received webhook for ${sensor} -> ${newState}`);
          const responseBody = {
            success: true,
          };

          // Loop through sensors to find which one to update
          // Will always return 200, even if sensor can't be found due to security reasons
          for (let i = 0; i < this.peopleProAccessories.length; i += 1) {
            const peopleProAccessory = this.peopleProAccessories[i];
            const { target } = peopleProAccessory;
            if (peopleProAccessory.name.toLowerCase() === sensor) {
              // Check if this sensor is excluded from webhook functionality; if so, ignore request
              if (peopleProAccessory.excludedFromWebhook !== true) {
                // Update webhook queue
                this.clearWebhookQueueForTarget(target);
                this.webhookQueue.push({
                  target,
                  newState,
                  timeoutvar: setTimeout((() => {
                    this.runWebhookFromQueueForTarget(target);
                  }), peopleProAccessory.ignoreWebhookReEnter * 1000),
                });
              }
              break;
            }
          }
          response.write(JSON.stringify(responseBody));
          response.end();
        }
      }));
    })).listen(this.webhookPort);
    this.log("Webhook: Started webserver on port '%s'.", this.webhookPort);
  }

  /**
   * Clears the current webhook queue / intervals for the given target
   * @param {string} target The target to clear the webhook queue for
   */
  clearWebhookQueueForTarget(target) {
    for (let i = 0; i < this.webhookQueue.length; i += 1) {
      const webhookQueueEntry = this.webhookQueue[i];
      if (webhookQueueEntry.target === target) {
        clearTimeout(webhookQueueEntry.timeoutvar);
        this.webhookQueue.splice(i, 1);
        break;
      }
    }
  }

  /**
   * Executes the webhook in the queue for the given target; called through an interval at
   * ignoreWebhookReEnter * 1000 from the webserver
   * @param {string} target The target to run the webhook for
   */
  runWebhookFromQueueForTarget(target) {
    for (let i = 0; i < this.webhookQueue.length; i += 1) {
      const webhookQueueEntry = this.webhookQueue[i];
      if (webhookQueueEntry.target === target) {
        this.log(`Running webhook for ${target} -> ${webhookQueueEntry.newState}`);
        this.webhookQueue.splice(i, 1);
        // Update sensor
        this.storage.setItemSync(`lastWebhook_${target}`, Date.now());
        this.getPeopleProAccessoryForTarget(target).setNewState(webhookQueueEntry.newState);
        break;
      }
    }
  }

  /**
   * Get a PeopleProAccessory based on a given target
   * @param {string} target IP address or hostname of the wanted PeopleProAccessory
   * @returns {object} The wanted PeopleProAccessory (or null if it couldn't be found)
   */
  getPeopleProAccessoryForTarget(target) {
    for (let i = 0; i < this.peopleProAccessories.length; i += 1) {
      const peopleProAccessory = this.peopleProAccessories[i];
      if (peopleProAccessory.target === target) {
        return peopleProAccessory;
      }
    }
    return null;
  }
}

/**
 * Set homebridge reference for platform, called from /index.js
 * @param {object} homebridgeRef The homebridge reference to use in the platform
 */
PeopleProPlatform.setHomebridge = (homebridgeRef) => {
  homebridge = homebridgeRef;
};

module.exports = PeopleProPlatform;
