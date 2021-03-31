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

function loadRoomInfo() {
    let that = this;
    //cloudh5.51miaomiao.com/service?time=1616594775513&code=getPm25AndWeather&province=%E4%B8%8A%E6%B5%B7%E5%B8%82&city=%E4%B8%8A%E6%B5%B7%E5%B8%82

    const url = "http://dev.51miaomiao.cn/axis2/services/openBuzService?wsdl"

    const options = {
        // url,
        // method: 'post',
        headers: {
            'content-type': "text/xml",
            'user-agent':'miao miao wu shang jia/20200921 (iPhone; iOS 14.5; Scale/3.00)',
            'SOAPAction':'http://dev.51miaomiao.cn:443/axis2/services/openBuzService?wsdl'
        },
        // data:
    };

    const xml = '<SOAP-ENV:Envelope xmlns:SOAP-ENV="http://schemas.xmlsoap.org/soap/envelope/" xmlns:SOAP-ENC="http://schemas.xmlsoap.org/soap/encoding/" xmlns:xsi="http://www.w3.org/2001/XMLSchema-instance" xmlns:xsd="http://www.w3.org/2001/XMLSchema" xmlns:ns1="http://www.buz.org/buzService/"><SOAP-ENV:Body><ns1:service><request>{"head":{"code":"getPuList","reqTime":"1616826130022.501953","accessKey":"","accessToken":"","v":"4.0","appVersion":"262661","appId":"ml_ios_miaomiaowu98276youywter08374rtg324586tia7us6e591iuywt","appToken":"3158f53d0d0c435932b67bf80b90da97"},"body":{"cuId":"299636","supportThirdCloud":"true"}}</request></ns1:service></SOAP-ENV:Body></SOAP-ENV:Envelope>'
    //Send request
    axios.post(url, xml,options).then(function(response) {
        let content = response.data.replace('<?xml version=\'1.0\' encoding=\'UTF-8\'?><soapenv:Envelope xmlns:soapenv="http://schemas.xmlsoap.org/soap/envelope/"><soapenv:Body><ns1:serviceResponse xmlns:ns1="http://www.miotlink.org/openBuzService/"><response>','')
        content = content.replace('</response></ns1:serviceResponse></soapenv:Body></soapenv:Envelope>','')
        // console.log('room info', content);
        const data = JSON.parse(content)

        let params = data.body.data.puList.map(function (d){
            const pu = {
                "client": "IOS",
                "kindId": d.kindId,
                "time": '1616894394091',
                "location": "",
                "modelId": d.modelId,
                "cuId": d.cuId,
                "puId": '276847',
                "language": "ZH",
                "token": "6e7c38795b1cde495cbe693b56dc4143"
            }
        // })
        //
        // params.forEach(function (p){
            const url = 'http://cloudh5.51miaomiao.com/h5Plugin?jsonParams=' + encodeURIComponent(JSON.stringify(pu))

            console.log('url',url)

            const options = {
                url,
                method:'get'
            }

            axios(options).then(function (resp) {
                // console.log(resp.data)
                // <input type="hidden" id="h5_wstoken" value="0A2313A4ED18AB968FE312B2333AA852" />
                //     <input type="hidden" id="h5_wstokenTime" value="1616894394091" />

                let start = resp.data.indexOf('<input type="hidden" id="h5_wstoken" value="');
                let end = resp.data.indexOf('" />', start)
                let len = '<input type="hidden" id="h5_wstoken" value="'.length

                let token = resp.data.substr(start + len, end - start -len )

                start = resp.data.indexOf('<input type="hidden" id="h5_wstokenTime" value="');
                end = resp.data.indexOf('" />', start)
                len = '<input type="hidden" id="h5_wstokenTime" value="'.length

                let tokenTime = resp.data.substr(start + len, end - start -len )

                console.log(token, tokenTime)

                "ws://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=" + this.cuId + "~" + this.puId + "~" + this.token + "~" + this.model + "~" + this.ts;
                let wsUrl = 'http://cloudh5.51miaomiao.com/servlet/SwapDataServlet?cuId=' + d.cuId + '~'+ d.puId +'~'+ token +'~'+d.modelId+'~'+tokenTime

                console.log(wsUrl)
            }).catch(function (e){
                console.log(e)
            })
        })


        // {
        //     "client": "IOS",
        //     "kindId": "300",
        //     "time": 1616894394091,
        //     "location": "",
        //     "modelId": "318",
        //     "cuId": "299636",
        //     "puId": "276847",
        //     "language": "ZH",
        //     "token": "6e7c38795b1cde495cbe693b56dc4143"
        // }

    }).catch(function (e){
        console.error(e, 'failed to load room info')
    })
}

loadRoomInfo();