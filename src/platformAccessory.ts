import type { CharacteristicValue, PlatformAccessory, Service } from 'homebridge';
import axios from 'axios';
import WebSocket from 'ws';
// import md5 from 'js-md5';

import type { HomeClimatePlatform } from './platform.js';
import {
  ACTION_CMD02,
  ACTION_CMD03,
  ACTION_CMD04,
  ACTION_CMD05,
  ACTION_GET_MAIN_STATE,
  ACK_REFRESH_PU_STATE,
  AIR_INFO_URL,
  RESULT_CODE,
  WS_BASE_URL,
  type HomeClimateDevice,
  type HomeClimatePlatformConfig,
} from './settings.js';

/** Shape of the jsonResults payload inside an updatePu WebSocket message */
interface PuStatePayload {
  actionNameAck?: string;
  state?: number;        // 1 = online
  ljgzsj_state?: number; // 累计工作时间
  fl_state?: number;     // 风量
  ifOpen1?: number;      // 开关机状态
  ifOpen2?: number;      // 睡眠
  ifOpen3?: number;      // 风阀开关
  wd_state?: number;     // 送风温度
  [key: string]: unknown;
}

interface WsMessage {
  actionCode?: string;
  resultCode?: number;
  jsonResults?: string;
  [key: string]: unknown;
}

/** HomeKit percentage range -> device speed value (for SET) */
const SPEED_RANGES: Array<[number, number, number]> = [
  [90, 100, 8], [77, 89, 7], [64, 76, 6], [51, 63, 5],
  [38, 50, 4], [25, 37, 3], [12, 24, 2], [1, 11, 1], [0, 0, 0],
];

/** device speed value -> HomeKit percentage (for GET / update) */
const SPEED_LEVELS = [0, 1, 12, 25, 38, 51, 64, 77, 90];

export class AirPurifierAccessory {
  private readonly service: Service;
  private readonly serviceInfo: Service;
  private airQualitySensorService?: Service;
  private temperatureSensorService?: Service;
  private humiditySensorService?: Service;
  private switchService?: Service;

  private ws: WebSocket | null = null;
  private heartbeatTimer?: NodeJS.Timeout;
  private reconnectTimer?: NodeJS.Timeout;

  /** device state reported by the cloud */
  private state = {
    accumulateWorkTime: 0, // 累计工作时间
    airFlowRate: 50,       // 风量
    activeMode: 0,         // 开关机状态
    sleepMode: 1,          // 睡眠
    airValveMode: 0,       // 风阀开关
    airTemperature: 0,     // 送风温度
  };

  /** outdoor weather / air quality from the cloud HTTP service */
  private temperature = 0;
  private humidity = 0;
  private aqi = 0;
  private pm25 = 0;

  private airQualityLevels: Array<[number, number]> ;

  constructor(
      private readonly platform: HomeClimatePlatform,
      private readonly accessory: PlatformAccessory,
  ) {
    const device = accessory.context.device as HomeClimateDevice;
    const config = platform.config as HomeClimatePlatformConfig;

    this.airQualityLevels = [
      [200, this.platform.Characteristic.AirQuality.POOR],
      [150, this.platform.Characteristic.AirQuality.INFERIOR],
      [100, this.platform.Characteristic.AirQuality.FAIR],
      [50, this.platform.Characteristic.AirQuality.GOOD],
      [0, this.platform.Characteristic.AirQuality.EXCELLENT],
    ];

    // set accessory information
    this.serviceInfo = this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.Manufacturer, 'Home Climate')
      .setCharacteristic(this.platform.Characteristic.Model, 'Air Purifier')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, device.puId.toString());

    // AirPurifier main service
    this.service = this.accessory.getService(this.platform.Service.AirPurifier)
        || this.accessory.addService(this.platform.Service.AirPurifier, device.displayName);

    this.service.setCharacteristic(this.platform.Characteristic.Name, device.displayName);

    this.service.getCharacteristic(this.platform.Characteristic.Active)
      .onGet(this.getActiveState.bind(this))
      .onSet(this.setActiveState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState)
      .onGet(this.getCurrentAirPurifierState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.TargetAirPurifierState)
      .onGet(this.getTargetAirPurifierState.bind(this))
      .onSet(this.setTargetAirPurifierState.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls)
      .onGet(this.getLockPhysicalControls.bind(this))
      .onSet(this.setLockPhysicalControls.bind(this));

    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed)
      .onGet(this.getRotationSpeed.bind(this))
      .onSet(this.setRotationSpeed.bind(this));

    if (config.showAirQuality) {
      this.airQualitySensorService = this.accessory.getService(this.platform.Service.AirQualitySensor)
          || this.accessory.addService(this.platform.Service.AirQualitySensor, config.nameAirQuality || 'Air Quality');

      this.airQualitySensorService
        .getCharacteristic(this.platform.Characteristic.AirQuality)
        .onGet(this.getAirQuality.bind(this));

      this.airQualitySensorService
        .getCharacteristic(this.platform.Characteristic.PM2_5Density)
        .onGet(this.getPM25.bind(this));
    }

    if (config.showTemperature) {
      this.temperatureSensorService = this.accessory.getService(this.platform.Service.TemperatureSensor)
          || this.accessory.addService(this.platform.Service.TemperatureSensor, config.nameTemperature || 'Temperature');

      this.temperatureSensorService
        .getCharacteristic(this.platform.Characteristic.CurrentTemperature)
        .onGet(this.getTemperature.bind(this));
    }

    if (config.showHumidity) {
      this.humiditySensorService = this.accessory.getService(this.platform.Service.HumiditySensor)
          || this.accessory.addService(this.platform.Service.HumiditySensor, config.nameHumidity || 'Humidity');

      this.humiditySensorService
        .getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity)
        .onGet(this.getHumidity.bind(this));
    }

    if (config.showSleepMode) {
      this.switchService = this.accessory.getService(this.platform.Service.Switch)
          || this.accessory.addService(this.platform.Service.Switch, `${device.displayName} 睡眠模式`);

      this.switchService
        .getCharacteristic(this.platform.Characteristic.On)
        .onGet(this.getSleepMode.bind(this))
        .onSet(this.setSleepMode.bind(this));
    }

    this.connect();
    void this.getAirInfo();
  }

  // ---------------------------------------------------------------------------
  // WebSocket connection
  // ---------------------------------------------------------------------------

  private async wsUrl(): Promise<string> {
    // const config = this.platform.config as HomeClimatePlatformConfig;
    const device = this.accessory.context.device as HomeClimateDevice;
    const wstoken = this.accessory.context.wstoken as string;
    const wstokenTime = this.accessory.context.wstokenTime as string;
    // const result = await this.login(config.username||'', config.password||'');
    // cuId + "~" + puId + "~" + token + "~" + model + "~" + ts
    return `${WS_BASE_URL}?cuId=${device.cuId}~${device.puId}~${wstoken}~${device.model}~${wstokenTime}`;
  }

  private async connect(): Promise<void> {
    const config = this.platform.config as HomeClimatePlatformConfig;
    const device = this.accessory.context.device as HomeClimateDevice;

    const url = await this.wsUrl();
    this.platform.log.debug('Connecting to HomeClimate cloud url %s', url);
    this.ws = new WebSocket(url);

    this.ws.on('open', () => {
      this.platform.log.info('Connected to HomeClimate cloud for %s', this.accessory.displayName);

      // query the current device state
      void this.loadStates();

      // start heartbeat
      this.heartbeatTimer = setInterval(() => {
        if (this.ws && this.ws.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ opType: '2', actionParams: '01' }));
          this.ws.send(JSON.stringify({
            actionName: `'${ACTION_GET_MAIN_STATE}'`,
            actionParams: '\'{}\'',
            id: device.puId.toString(),
            kindId: device.kindId.toString(),
            modelId: device.model.toString(),
          }));
        }
      }, config.heartbeatInterval ?? 1000);
    });

    this.ws.on('error', (error: Error) => {
      this.platform.log.error('WebSocket error for %s: %s — will retry in 30 seconds',
        this.accessory.displayName, error.message);
      this.scheduleReconnect();
    });

    this.ws.on('close', () => {
      this.scheduleReconnect();
    });

    this.ws.on('message', (data: WebSocket.RawData) => {
      this.handleMessage(data.toString());
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return;
    }
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      if (this.ws) {
        this.ws.removeAllListeners();
        try {
          this.ws.terminate();
        } catch {
          // ignore
        }
      }
      this.connect();
    }, 30000);
  }

  /** Close the WebSocket and stop timers (called by the platform on shutdown). */
  destroy(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
    if (this.ws) {
      this.ws.removeAllListeners();
      try {
        this.ws.terminate();
      } catch {
        // ignore
      }
      this.ws = null;
    }
  }

  private handleMessage(raw: string): void {
    this.platform.log.debug('Receiving data for %s: %s', this.accessory.displayName, raw);

    let data: WsMessage;
    try {
      data = JSON.parse(raw) as WsMessage;
    } catch {
      this.platform.log.warn('Ignoring malformed WebSocket message: %s', raw);
      return;
    }

    if (data.actionCode === 'updateAd' || data.actionCode === 'Heart_Beat') {
      return;
    }

    if (data.actionCode !== 'updatePu') {
      return;
    }

    const resultCode = data.resultCode;

    if (resultCode === RESULT_CODE.SUCCESS) {
      let details: PuStatePayload;
      try {
        details = JSON.parse(data.jsonResults ?? '{}') as PuStatePayload;
      } catch {
        this.platform.log.warn('Could not parse jsonResults: %s', data.jsonResults);
        return;
      }

      if (details.actionNameAck === ACK_REFRESH_PU_STATE && details.state !== 1) {
        this.platform.log.warn('Device %s is offline', this.accessory.displayName);
        return;
      }

      this.state = {
        accumulateWorkTime: typeof(details.ljgzsj_state) !== 'undefined' ? details.ljgzsj_state : 0,
        airFlowRate: typeof(details.fl_state ) !== 'undefined' ?details.fl_state : 0,
        activeMode: typeof(details.ifOpen1 ) !== 'undefined' ?details.ifOpen1 : 0,
        sleepMode: typeof(details.ifOpen2 ) !== 'undefined' ? details.ifOpen2 : 1,
        airValveMode: typeof(details.ifOpen3 ) !== 'undefined' ?details.ifOpen3 :  0,
        airTemperature: typeof(details.wd_state ) !== 'undefined' ? details.wd_state : 0,
      };

      // push the new values to HomeKit
      this.updateActiveState(details.ifOpen1 ?? 0);
      this.updateLockPhysicalControlsState(details.ifOpen3 ?? 0);
      this.updateRotationSpeedState(details.fl_state ?? 0);
      this.updateSleepModeState(details.ifOpen2 ?? 1);
      this.updateCurrentAirPurifierState(details.ifOpen1 ?? 0);
    } else if (resultCode === RESULT_CODE.FAIL) {
      this.platform.log.warn('数据解析回复失败');
    } else if (resultCode === RESULT_CODE.SEND_SUCCESS) {
      // 数据发送成功，无需处理
    } else if (resultCode === RESULT_CODE.PU_LOGOUT) {
      this.platform.log.warn('设备已离线');
    } else if (resultCode === RESULT_CODE.UNSUPPORT_PU_KIND) {
      this.platform.log.warn('未知设备类型');
    } else if (resultCode === RESULT_CODE.UNSUPPORT_PU_MODEL) {
      this.platform.log.warn('未知设备型号');
    } else if (resultCode === RESULT_CODE.UNSUPPORT_PU_ACTION_NAME) {
      this.platform.log.warn('未知请求名');
    } else if (resultCode === RESULT_CODE.SEND_FAIL) {
      this.platform.log.warn('数据发送失败');
    } else {
      this.platform.log.warn('未知错误[%s]', String(resultCode));
    }
  }

  private async loadStates(): Promise<void> {
    await this.doAction(ACTION_GET_MAIN_STATE, {});
  }

  /**
   * Send a command to the device through the cloud WebSocket.
   * Resolves ~50 ms after the frame is accepted (same behaviour as the original plugin).
   */
  private doAction(actionName: string, params: Record<string, unknown>): Promise<void> {
    const device = this.accessory.context.device as HomeClimateDevice;

    return new Promise((resolve, reject) => {
      if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
        reject(new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE));
        return;
      }

      const contextJson = {
        actionName: `'${actionName}'`,
        actionParams: `'${JSON.stringify(params)}'`,
        id: device.puId.toString(),
        kindId: device.kindId.toString(),
        modelId: device.model.toString(),
      };

      this.ws.send(JSON.stringify(contextJson), (err:Error|undefined) => {
        if(err){
          setTimeout(()=>{
            reject(err);
          }, 50);
        }else{
          setTimeout(resolve, 50);
        }
      });
    });
  }

  /** helper replacing the original `ws.set(...)` */
  private async setDeviceState(name: 'sleep' | 'speed' | 'lock' | 'power', value: number | string): Promise<void> {
    switch (name) {
    case 'sleep':
      await this.doAction(ACTION_CMD05, { message: String(value) });
      break;
    case 'speed':
      await this.doAction(ACTION_CMD03, { message: value });
      break;
    case 'lock':
      await this.doAction(ACTION_CMD04, { message: value });
      break;
    case 'power':
      if (this.state.accumulateWorkTime > 5000) {
        this.platform.log.warn('滤芯累计工作时间超过 5000 小时，建议更换滤芯');
      }
      if(value === 0 ){ //power off
        await this.doAction(ACTION_CMD05, { message: '0' });
      }
      await this.doAction(ACTION_CMD02, { message: value });
      break;
    }
  }

  private assertConnected(): void {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) {
      // show the device as "Not Responding" in the Home app
      throw new this.platform.api.hap.HapStatusError(
        this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);
    }
  }

  // ---------------------------------------------------------------------------
  // Outdoor weather / air quality (cloud HTTP service)
  // ---------------------------------------------------------------------------

  private async getAirInfo(): Promise<void> {
    const config = this.platform.config as HomeClimatePlatformConfig;
    const province = encodeURIComponent(config.province ?? '上海市');
    const city = encodeURIComponent(config.city ?? '上海市');

    try {
      const response = await axios.get(
        `${AIR_INFO_URL}?time=${Date.now()}&code=getPm25AndWeather&province=${province}&city=${city}`,
        { headers: { 'content-type': 'application/json' } });

      const data = response.data as {
        miotTemperature?: number; miotAqi?: number; miotPM2_5?: number; miotSD?: number;
      };

      this.platform.log.debug('Air info for %s: %j', this.accessory.displayName, data);

      this.temperature = data.miotTemperature ?? 0;
      this.aqi = data.miotAqi ?? 0;
      this.pm25 = data.miotPM2_5 ?? 0;
      this.humidity = data.miotSD ?? 0;

      this.updateAirQuality(data.miotAqi??0);
      this.updateHumidity(data.miotSD ?? 0);
      this.updateTemperature(data.miotTemperature ?? 0);
      this.updatePM25(data.miotPM2_5 ?? 0);
    } catch (error) {
      this.platform.log.error('Failed to load air info: %s', String(error));
    }
  }

  // ---------------------------------------------------------------------------
  // Active (on/off)
  // ---------------------------------------------------------------------------

  async getActiveState(): Promise<CharacteristicValue> {
    this.assertConnected();
    const state = this.state.activeMode
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.platform.log.debug('Get Characteristic Active -> %s', state);
    return state;
  }

  async setActiveState(value: CharacteristicValue): Promise<void> {
    this.assertConnected();
    this.platform.log.debug('Set Characteristic Active -> %s', value);
    await this.setDeviceState('power', value as number);
  }

  updateActiveState(mode: number): void {
    const state = mode
      ? this.platform.Characteristic.Active.ACTIVE
      : this.platform.Characteristic.Active.INACTIVE;
    this.platform.log.debug('Update Characteristic Active -> %s (mode %s)', state, mode);
    this.service.getCharacteristic(this.platform.Characteristic.Active).updateValue(state);
  }

  // ---------------------------------------------------------------------------
  // CurrentAirPurifierState
  // ---------------------------------------------------------------------------

  async getCurrentAirPurifierState(): Promise<CharacteristicValue> {
    this.assertConnected();
    const state = this.state.activeMode === 0
      ? this.platform.Characteristic.CurrentAirPurifierState.INACTIVE
      : this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR;
    this.platform.log.debug('Get Characteristic CurrentAirPurifierState -> %s', state);
    return state;
  }

  updateCurrentAirPurifierState(mode: number): void {
    const state = mode
      ? this.platform.Characteristic.CurrentAirPurifierState.PURIFYING_AIR
      : this.platform.Characteristic.CurrentAirPurifierState.INACTIVE;
    this.platform.log.debug('Update Characteristic CurrentAirPurifierState -> %s', state);
    this.service.getCharacteristic(this.platform.Characteristic.CurrentAirPurifierState).updateValue(state);
  }

  // ---------------------------------------------------------------------------
  // TargetAirPurifierState (auto / manual)
  // ---------------------------------------------------------------------------

  async getTargetAirPurifierState(): Promise<CharacteristicValue> {
    this.assertConnected();
    const state = (this.state.airFlowRate === 4 && this.state.sleepMode === 1)
      ? this.platform.Characteristic.TargetAirPurifierState.AUTO
      : this.platform.Characteristic.TargetAirPurifierState.MANUAL;
    this.platform.log.debug('Get Characteristic TargetAirPurifierState -> %s', state);
    return state;
  }

  async setTargetAirPurifierState(value: CharacteristicValue): Promise<void> {
    this.assertConnected();
    this.platform.log.debug('Set Characteristic TargetAirPurifierState -> %s', value);

    if (value === this.platform.Characteristic.TargetAirPurifierState.MANUAL) {
      // 手动模式：恢复当前风量
      await this.setDeviceState('speed', this.state.airFlowRate);
    } else {
      // 自动模式：风量设为 4 档
      await this.setDeviceState('speed', 4);
    }
  }

  // ---------------------------------------------------------------------------
  // LockPhysicalControls (风阀开关)
  // ---------------------------------------------------------------------------

  async getLockPhysicalControls(): Promise<CharacteristicValue> {
    this.assertConnected();
    const state = this.state.airValveMode
      ? this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    this.platform.log.debug('Get Characteristic LockPhysicalControls -> %s', state);
    return state;
  }

  async setLockPhysicalControls(value: CharacteristicValue): Promise<void> {
    this.assertConnected();
    this.platform.log.debug('Set Characteristic LockPhysicalControls -> %s', value);
    await this.setDeviceState('lock', value as number);
  }

  updateLockPhysicalControlsState(mode: number): void {
    const state = mode
      ? this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_ENABLED
      : this.platform.Characteristic.LockPhysicalControls.CONTROL_LOCK_DISABLED;
    this.platform.log.debug('Update Characteristic LockPhysicalControls -> %s', state);
    this.service.getCharacteristic(this.platform.Characteristic.LockPhysicalControls).updateValue(state);
  }

  // ---------------------------------------------------------------------------
  // RotationSpeed (风量)
  // ---------------------------------------------------------------------------

  async getRotationSpeed(): Promise<CharacteristicValue> {
    this.assertConnected();
    const speed = this.state.airFlowRate;
    this.platform.log.debug('Get Characteristic RotationSpeed -> device speed %s', speed);
    const range = SPEED_RANGES.find((item) => item[2] === speed);
    return range ? range[0] + 2 : 0;
  }

  async setRotationSpeed(value: CharacteristicValue): Promise<void> {
    this.assertConnected();
    this.platform.log.debug('Set Characteristic RotationSpeed -> %s', value);
    const percent = value as number;
    const range = SPEED_RANGES.find((item) => percent >= item[0] && percent <= item[1]);
    if (range) {
      await this.setDeviceState('speed', range[2]);
    }
  }

  updateRotationSpeedState(speed: number): void {
    const percent = SPEED_LEVELS[speed] !== undefined ? SPEED_LEVELS[speed] + 2 : 0;
    this.platform.log.debug('Update Characteristic RotationSpeed -> %s', percent);
    this.service.getCharacteristic(this.platform.Characteristic.RotationSpeed).updateValue(percent);
  }

  // ---------------------------------------------------------------------------
  // AirQuality / PM2.5
  // ---------------------------------------------------------------------------

  async getAirQuality(): Promise<CharacteristicValue> {
    this.assertConnected();
    this.platform.log.debug('Get Characteristic AirQuality -> %s', this.aqi);
    for (const item of this.airQualityLevels) {
      if (this.aqi >= item[0]) {
        return item[1];
      }
    }
    return this.platform.Characteristic.AirQuality.UNKNOWN;
  }

  updateAirQuality(value: number): void {
    if (!this.airQualitySensorService) {
      return;
    }
    this.aqi = value;
    this.platform.log.debug('Update Characteristic AirQuality -> %s', value);
    for (const item of this.airQualityLevels) {
      if (value >= item[0]) {
        this.airQualitySensorService.getCharacteristic(this.platform.Characteristic.AirQuality).updateValue(item[1]);
        return;
      }
    }
  }

  async getPM25(): Promise<CharacteristicValue> {
    this.assertConnected();
    this.platform.log.debug('Get Characteristic PM2.5Density -> %s', this.pm25);
    return this.pm25;
  }

  updatePM25(value: number): void {
    if (!this.airQualitySensorService) {
      return;
    }
    this.pm25 = value;
    this.platform.log.debug('Update Characteristic PM2_5Density -> %s', value);
    this.airQualitySensorService.getCharacteristic(this.platform.Characteristic.PM2_5Density).updateValue(value);
  }

  // ---------------------------------------------------------------------------
  // Temperature / Humidity
  // ---------------------------------------------------------------------------

  async getTemperature(): Promise<CharacteristicValue> {
    this.assertConnected();
    this.platform.log.debug('Get Characteristic CurrentTemperature -> %s', this.temperature);
    return this.temperature;
  }

  updateTemperature(value: number): void {
    if (!this.temperatureSensorService) {
      return;
    }
    this.temperature = value;
    this.platform.log.debug('Update Characteristic CurrentTemperature -> %s', value);
    this.temperatureSensorService.getCharacteristic(this.platform.Characteristic.CurrentTemperature).updateValue(value);
  }

  async getHumidity(): Promise<CharacteristicValue> {
    this.assertConnected();
    this.platform.log.debug('Get Characteristic CurrentRelativeHumidity -> %s', this.humidity);
    return this.humidity;
  }

  updateHumidity(value: number): void {
    if (!this.humiditySensorService) {
      return;
    }
    this.humidity = value;
    this.platform.log.debug('Update Characteristic CurrentRelativeHumidity -> %s', value);
    this.humiditySensorService.getCharacteristic(this.platform.Characteristic.CurrentRelativeHumidity).updateValue(value);
  }

  // ---------------------------------------------------------------------------
  // Sleep Mode (睡眠模式)
  // ---------------------------------------------------------------------------

  async getSleepMode(): Promise<CharacteristicValue> {
    this.assertConnected();
    const state = this.state.sleepMode !== 1;
    this.platform.log.debug('Get Characteristic Sleep Mode On -> %s', state);
    return state;
  }

  async setSleepMode(value: CharacteristicValue): Promise<void> {
    this.assertConnected();
    if (this.switchService && this.state.activeMode === 1) {
      this.platform.log.debug('Set Characteristic Sleep Mode On -> %s', value);
      await this.setDeviceState('sleep', value ? 1 : 0);
    }
  }

  updateSleepModeState(sleepMode: number): void {
    if (!this.switchService) {
      return;
    }
    this.platform.log.debug('Update Characteristic Sleep Mode On -> %s', sleepMode === 1);
    this.switchService.getCharacteristic(this.platform.Characteristic.On).updateValue(sleepMode === 1);
  }
}