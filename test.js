// const WebSocket = require('ws');
// const request = require('request')
const axios = require('axios')

// function test(){
//     const url =
//         "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=299636~213444~8684B9EF8349568E9A5F0B1857EC79CF~318~1616594775042"
//
//         "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=299636~213444~8684B9EF8349568E9A5F0B1857EC79CF~318~1616594775042"
//         "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=299636~213444~8684B9EF8349568E9A5F0B1857EC79CF~318~1616677581549"
//
//     this.ws = new WebSocket(url);
//
//     this.ws.on('open', function open() {
//         console.log('connected')
//     });
//
//     this.ws.on('error', function (e) {
//         console.log('Error in WebSocket communication, error is %s', e);
//         console.log('Will retry after 30 seconds');
//
//     });
//
//     this.ws.on('message', function(msg, flags) {
//         console.log(msg)
//     });
//
// }

function test2() {
    //cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82

    const url = "http://cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82"

    const options = {
        url,
        method: 'get',
        headers: {
            'content-type': "application/json"
        }
    };
    //Send request
    axios(options).then(function(response)  {
        console.log(response.data)
        const data = JSON.parse(response.data)
        this.temperature = data.miotTemperature;
        this.aqi = data.miotAqi;
        this.pm25 = data.miotPM2_5;
        this.humidity = data.miotSD;
    }).catch(function (e){console.error(e)})
}

test2();