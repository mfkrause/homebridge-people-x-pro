const storage = require('node-persist');
const http = require('http');
const url = require('url');

const PeopleProAccessory = require('./accessory');
const PeopleProAllAccessory = require('./all_accessory');

const SENSOR_ANYONE = 'Anyone';
const SENSOR_NOONE = 'No One';

let homebridge;

class PeopleProPlatform {
  constructor(log, config) {
    this.log = log;
    this.threshold = config.threshold || 15;
    this.anyoneSensor = ((typeof (config.anyoneSensor) !== 'undefined' && config.anyoneSensor !== null) ? config.anyoneSensor : true);
    this.nooneSensor = ((typeof (config.nooneSensor) !== 'undefined' && config.nooneSensor !== null) ? config.nooneSensor : false);
    this.webhookPort = config.webhookPort || 51828;
    this.cacheDirectory = config.cacheDirectory || homebridge.user.persistPath();
    this.pingInterval = config.pingInterval || 10000;
    this.ignoreReEnterExitSeconds = config.ignoreReEnterExitSeconds || 0;
    this.people = config.people;
    this.storage = storage;
    this.storage.initSync({ dir: this.cacheDirectory });
    this.webhookQueue = [];
  }

  accessories(callback) {
    this.accessories = [];
    this.peopleProAccessories = [];
    for (let i = 0; i < this.people.length; i += 1) {
      const peopleProAccessory = new PeopleProAccessory(this.log, this.people[i], this);
      this.accessories.push(peopleProAccessory);
      this.peopleProAccessories.push(peopleProAccessory);
    }
    if (this.anyoneSensor) {
      this.peopleAnyOneAccessory = new PeopleProAllAccessory(this.log, SENSOR_ANYONE, this);
      this.accessories.push(this.peopleAnyOneAccessory);
    }
    if (this.nooneSensor) {
      this.peopleNoOneAccessory = new PeopleProAllAccessory(this.log, SENSOR_NOONE, this);
      this.accessories.push(this.peopleNoOneAccessory);
    }
    callback(this.accessories);

    this.startServer();
  }

  startServer() {
    //
    // HTTP webserver code influenced by benzman81's great
    // homebridge-http-webhooks homebridge plugin.
    // https://github.com/benzman81/homebridge-http-webhooks
    //

    // Start the HTTP webserver
    http.createServer(((request, response) => {
      const theUrl = request.url;
      const theUrlParts = url.parse(theUrl, true);
      const theUrlParams = theUrlParts.query;
      let body = [];
      request.on('error', ((err) => {
        this.log('WebHook error: %s.', err);
      })).on('data', (chunk) => {
        body.push(chunk);
      }).on('end', (() => {
        body = Buffer.concat(body).toString();

        response.on('error', (err) => {
          this.log('WebHook error: %s.', err);
        });

        response.statusCode = 200;
        response.setHeader('Content-Type', 'application/json');

        if (!theUrlParams.sensor || !theUrlParams.state) {
          response.statusCode = 404;
          response.setHeader('Content-Type', 'text/plain');
          const errorText = 'WebHook error: No sensor or state specified in request.';
          this.log(errorText);
          response.write(errorText);
          response.end();
        } else {
          const sensor = theUrlParams.sensor.toLowerCase();
          const newState = (theUrlParams.state === 'true');
          this.log(`Received hook for ${sensor} -> ${newState}`);
          const responseBody = {
            success: true,
          };
          for (let i = 0; i < this.peopleProAccessories.length; i += 1) {
            const peopleProAccessory = this.peopleProAccessories[i];
            const { target } = peopleProAccessory;
            if (peopleProAccessory.name.toLowerCase() === sensor) {
              this.clearWebhookQueueForTarget(target);
              this.webhookQueue.push({
                target,
                newState,
                timeoutvar: setTimeout((() => {
                  this.runWebhookFromQueueForTarget(target);
                }), peopleProAccessory.ignoreReEnterExitSeconds * 1000),
              });
              break;
            }
          }
          response.write(JSON.stringify(responseBody));
          response.end();
        }
      }));
    })).listen(this.webhookPort);
    this.log("WebHook: Started server on port '%s'.", this.webhookPort);
  }

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

  runWebhookFromQueueForTarget(target) {
    for (let i = 0; i < this.webhookQueue.length; i += 1) {
      const webhookQueueEntry = this.webhookQueue[i];
      if (webhookQueueEntry.target === target) {
        this.log(`Running hook for ${target} -> ${webhookQueueEntry.newState}`);
        this.webhookQueue.splice(i, 1);
        this.storage.setItemSync(`lastWebhook_${target}`, Date.now());
        this.getPeopleProAccessoryForTarget(target).setNewState(webhookQueueEntry.newState);
        break;
      }
    }
  }

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

PeopleProPlatform.setHomebridge = (homebridgeRef) => {
  homebridge = homebridgeRef;
};

module.exports = PeopleProPlatform;
