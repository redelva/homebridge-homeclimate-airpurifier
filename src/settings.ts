import type { PlatformConfig } from 'homebridge';
/**
 * This is the name of the platform that users will use to register the plugin in the Homebridge config.json
 */
export const PLATFORM_NAME = 'HomeClimate';

/**
 * This must match the name of your plugin as defined the package.json `name` property
 */
export const PLUGIN_NAME = 'homebridge-homeclimate-airpurifier';


/** Endpoints used by the HomeClimate (妙妙屋) cloud */
export const WS_BASE_URL = 'ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet';
export const SOAP_URL = 'https://dev.51miaomiao.cn/axis2/services/openBuzService';
export const AIR_INFO_URL = 'http://cloudh5.51miaomiao.com/service';

/** WebSocket message resultCode values */
export const RESULT_CODE = {
  INIT: 0,               // 初始化数据
  SUCCESS: 1,            // 数据解析回复正确
  FAIL: 2,               // 数据解析回复失败
  SEND_SUCCESS: 3,       // 数据发送成功
  PU_LOGOUT: 4,          // 设备离线
  UNSUPPORT_PU_KIND: 5,  // 不支持此设备类型
  UNSUPPORT_PU_MODEL: 6, // 不支持此设备型号
  UNSUPPORT_PU_ACTION_NAME: 7, // 不支持此actionName方法
  SEND_FAIL: 8,          // 发送失败
  PU_ONLINE: 9,          // 设备上线
  PU_OFFLINE: 10,        // 设备下线
} as const;

/** actionNameAck sent back inside jsonResults */
export const ACK_REFRESH_PU_STATE = 'refreshPuState';
export const ACK_REFRESH_ALL = 'refreshAll';

/** actionName commands */
export const ACTION_GET_MAIN_STATE = 'getMainState'; // 查询信息
export const ACTION_CMD02 = 'cmd02'; // 设置开关机
export const ACTION_CMD03 = 'cmd03'; // 调节风量
export const ACTION_CMD04 = 'cmd04'; // 风阀开关
export const ACTION_CMD05 = 'cmd05'; // 睡眠

/** A single device (PU) parsed from the getPuList SOAP response */
export interface HomeClimateDevice {
    puId: number;
    cuId: number;
    displayName: string;
    kindId: string;
    model: number;
    online?: boolean;
}

export interface HomeClimatePlatformConfig extends PlatformConfig {
    username: string;
    password: string;
    showAirQuality?: boolean;
    showTemperature?: boolean;
    showHumidity?: boolean;
    showSleepMode?: boolean;
    province?: string;
    city?: string;
    heartbeatInterval?: number;
}