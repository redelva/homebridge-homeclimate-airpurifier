import type { API, Characteristic, DynamicPlatformPlugin, Logging, PlatformAccessory, PlatformConfig, Service } from 'homebridge';
import axios from 'axios';

import { AirPurifierAccessory } from './platformAccessory.js';
import {
  PLATFORM_NAME,
  PLUGIN_NAME,
  // SOAP_URL,
  type HomeClimateDevice,
  type HomeClimatePlatformConfig,
} from './settings.js';
import md5 from 'js-md5';

export class HomeClimatePlatform implements DynamicPlatformPlugin {
  public readonly Service: typeof Service;
  public readonly Characteristic: typeof Characteristic;

  public readonly accessories: Map<string, PlatformAccessory> = new Map();
  public readonly discoveredCacheUUIDs: string[] = [];

  // live accessory handlers, used to close WebSocket connections on shutdown
  private readonly handlers: AirPurifierAccessory[] = [];

  constructor(
      public readonly log: Logging,
      public readonly config: PlatformConfig,
      public readonly api: API,
  ) {
    this.Service = api.hap.Service;
    this.Characteristic = api.hap.Characteristic;

    this.log.debug('Finished initializing platform:', this.config.name);

    this.api.on('didFinishLaunching', () => {
      log.debug('Executed didFinishLaunching callback');
      void this.discoverDevices();
    });

    this.api.on('shutdown', () => {
      for (const handler of this.handlers) {
        handler.destroy();
      }
    });
  }

  registerHandler(handler: AirPurifierAccessory): void {
    this.handlers.push(handler);
  }

  configureAccessory(accessory: PlatformAccessory) {
    this.log.info('Loading accessory from cache:', accessory.displayName);
    this.accessories.set(accessory.UUID, accessory);
  }

  private getInputValueById(html:string, id:string):string {
    // 先匹配包含指定 id 的 input 标签
    const tagReg = new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
    const tagMatch = html.match(tagReg);

    if (!tagMatch) {
      return '';
    }

    // 再从该 input 标签中提取 value
    const valueMatch = tagMatch[0].match(/\bvalue=["']([^"']*)["']/i);
    return valueMatch ? valueMatch[1] : '';
  }

  private getInputValuesById(html:string, id:string):string[] {
    // 先匹配包含指定 id 的 input 标签
    const tagReg = new RegExp(`<input\\b[^>]*\\bid=["']${id}["'][^>]*>`, 'i');
    const tagMatches = html.match(tagReg);

    if (!tagMatches) {
      return [];
    }

    return tagMatches.map(tagMatch => {
      const valueMatch = tagMatch.match(/\bvalue=["']([^"']*)["']/i);
      return valueMatch ? valueMatch[1] : '';
    });
  }

  private exactDisplayName(html:string):string[] {
    const reg = /<span\b[^>]*class=["'][^"']*\bpuNameHei\b[^"']*["'][^>]*>([\s\S]*?)<\/span>/gi;
    const names = [];
    let m;

    while ((m = reg.exec(html)) !== null) {
      names.push(m[1].replace(/<[^>]+>/g, '').trim());
    }

    return names;
  }

  private async login():Promise<{ wstoken: string, wstokenTime: string,devices:HomeClimateDevice[] }>{
    const config = this.config as HomeClimatePlatformConfig;

    const url = 'http://cloudh5.51miaomiao.com/login/doLogin';

    const time = new Date().getTime();
    const random = parseInt((Math.random() * 10).toFixed(0)) + '' +
        parseInt((Math.random() * 100).toFixed(0)) + '' +
        parseInt((Math.random() * 1000).toFixed(0));
    const token = md5.md5('username:' + config.username + ',time:' + time + ',pwd:' + config.password + ',random:' + random);

    const data:Record<string, string|number> = {
      widthValue:571,
      heightValue:938,
      loginName: config.username,
      time:time,
      random:random,
      token:token,
      string_loginName:config.username,
      string_password: config.password,
    };

    const params = new URLSearchParams({});
    for (const dataKey in data) {
      params.append(dataKey, data[dataKey].toString());
    }

    // this.log.info('data', params.toString());

    const resp = await axios.post(url, params, { headers:{
      'content-type': 'application/x-www-form-urlencoded',
    } });

    const wstoken = this.getInputValueById(resp.data, 'wstoken');
    const wstokenTime = this.getInputValueById(resp.data, 'wstokenTime');

    const cuId = this.getInputValueById(resp.data, 'ws_cuId');
    const puIdStrList = this.getInputValueById(resp.data, 'puIdStrList');
    const keys = this.getInputValuesById(resp.data, 'key');
    const names = this.exactDisplayName(resp.data);

    const devices = puIdStrList
      .split('~')
      .filter((s:string) => s.length > 0)
      .map((pu:string, i:number) => {
        const params = keys[i].split(',');
        const state = this.getInputValueById(resp.data, 'state_' + params[2]);
        const modelId = params[1];
        return {
          cuId:parseInt(cuId,10),
          puId: parseInt(pu,10),
          displayName: names[i],
          kindId: params[0],
          model: parseInt(modelId, 10),
          online: state === '1',
        };
      });

    return { wstoken, wstokenTime,devices };
  }

  /**
   * Query the cloud getPuList service and parse the device list.
   * Each entry of `body.data.puList` becomes a HomeclimateDevice.
   */
  // private async loadDeviceInfo(): Promise<HomeClimateDevice[]> {
  //   const config = this.config as HomeClimatePlatformConfig;
  //
  //   const request = JSON.stringify({
  //     head: {
  //       reqTime: Date.now().toString(),
  //       appVersion: '327681',
  //       code: 'getPuList',
  //       accessKey: '',
  //       v: '6.0',
  //       accessToken: config.soapAccessToken ?? '',
  //       appId: config.soapAppId ?? '',
  //       sign: config.soapSign ?? '',
  //     },
  //     body: {
  //       cuId: config.cuId,
  //       supportThirdCloud: 'true',
  //     },
  //   });
  //
  //   const envelope =
  //       '<?xml version="1.0" encoding="utf-8"?>' +
  //       '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" ' +
  //       'xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" ' +
  //       'xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" ' +
  //       'xmlns:xsd="http://www.w3.org/2001/XMLSchema" ' +
  //       'xmlns:ns1="http://www.buz.org/buzService/">' +
  //       '<SOAP-ENV:Body><ns1:service><request>' +
  //       escapeXml(request) +
  //       '</request></ns1:service></SOAP-ENV:Body></SOAP-ENV:Envelope>';
  //
  //   const response = await axios.post<string>(SOAP_URL, envelope, {
  //     headers: {
  //       'content-type': 'text/xml; charset=utf-8',
  //       'SOAPAction': 'https://dev.51miaomiao.cn:443/axis2/services/openBuzService',
  //       'user-agent': 'miao miao wu shang jia/2025121201 (iPhone; iOS 26.1; Scale/3.00)',
  //     },
  //     responseType: 'text',
  //     transformResponse: [(data) => data], // keep the raw XML body
  //   });
  //
  //   this.log.debug('getPuList SOAP response:', response.data);
  //
  //   // unwrap the <response> element and decode the HTML entities used by the cloud
  //   const match = /<response>([\s\S]*?)<\/response>/.exec(response.data);
  //   const jsonText = (match?.[1] ?? '')
  //     .replace(/&quot;/g, '"')
  //     .replace(/&#58;/g, ':')
  //     .replace(/&amp;/g, '&');
  //
  //   const parsed = JSON.parse(jsonText) as SoapResponse;
  //
  //   if (parsed.body?.resultCode !== '1') {
  //     throw new Error(`getPuList failed: ${parsed.body?.resultMsg ?? 'unknown error'}`);
  //   }
  //
  //   const puList = parsed.body.data?.puList ?? [];
  //
  //   this.log.info(`Discovered ${puList.length} device(s) from HomeClimate cloud`);
  //
  //   return puList
  //     .map((pu) => ({
  //       puId: String(pu.puId ?? ''),
  //       displayName: String(pu.puName ?? pu.name ?? `Air Purifier ${pu.puId}`),
  //       kindId: String(pu.puKindId ?? config.kindId ?? ''),
  //       model: String(pu.puModel ?? config.model ?? ''),
  //       online: pu.state === undefined ? undefined : String(pu.state) === '1',
  //     }))
  //     .filter((device) => device.puId.length > 0);
  // }

  /**
   * Discover devices via the cloud service and register one accessory per device.
   */
  async discoverDevices() {
    this.log.info('Discovering devices');

    // eslint-disable-next-line no-useless-assignment
    let devices: HomeClimateDevice[] = [];
    let wstoken, wstokenTime;

    try {
      const result = await this.login();
      devices = result.devices;
      wstoken = result.wstoken;
      wstokenTime = result.wstokenTime;
    } catch (error) {
      this.log.error('Failed to discover devices from HomeClimate cloud:', error);
      return;
    }

    this.log.info('Discovering '+devices.length +' devices from HomeClimate devices');

    for (const device of devices) {
      // uuid generated from the globally unique, constant puId
      const uuid = this.api.hap.uuid.generate(`homeclimate-${device.puId}`);

      const existingAccessory = this.accessories.get(uuid);

      if (existingAccessory) {
        this.log.info('Restoring existing accessory from cache:', existingAccessory.displayName);

        // keep the freshly discovered device info in the accessory context
        existingAccessory.context.device = device;
        this.api.updatePlatformAccessories([existingAccessory]);

        this.registerHandler(new AirPurifierAccessory(this, existingAccessory));
      } else {
        this.log.info('Adding new accessory:', device.displayName);

        const accessory = new this.api.platformAccessory(device.displayName, uuid);
        accessory.context.device = device;
        accessory.context.wstoken = wstoken;
        accessory.context.wstokenTime = wstokenTime;

        this.registerHandler(new AirPurifierAccessory(this, accessory));

        this.api.registerPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }

      this.discoveredCacheUUIDs.push(uuid);
    }

    // remove cached accessories that are no longer present in the cloud account
    for (const [uuid, accessory] of this.accessories) {
      if (!this.discoveredCacheUUIDs.includes(uuid)) {
        this.log.info('Removing existing accessory from cache:', accessory.displayName);
        this.api.unregisterPlatformAccessories(PLUGIN_NAME, PLATFORM_NAME, [accessory]);
      }
    }
  }
}