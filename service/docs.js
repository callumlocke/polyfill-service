var fs = require('fs');
var path = require('path');
var request = require('request-promise');
var Handlebars = require('handlebars');
var moment = require('moment');
var sources = require('../lib/sources');
var marked = require('marked');

var cache = {};
var cachettl = 1800;

// Pre-cache page templates and partials
var templates = ['index', 'usage', 'compat', 'api', 'examples', 'contributing'].reduce(function(map, temName) {
	map[temName] = Handlebars.compile(
		fs.readFileSync(path.join(__dirname, '/../docs/' + temName + '.html'), {encoding: 'UTF-8'})
	);
	return map;
}, {});
['header', 'footer', 'nav'].forEach(function(partialName) {
	Handlebars.registerPartial(partialName, Handlebars.compile(
		fs.readFileSync(path.join(__dirname, '/../docs/'+partialName+'.html'), {encoding: 'UTF-8'})
	));
});

// Register template helpers
Handlebars.registerHelper("prettifyDate", function(timestamp) {
     return moment(timestamp*1000).format("D MMM YYYY HH:mm");
});
Handlebars.registerHelper("prettifyDuration", function(seconds) {
     return moment.duration(seconds*1000).humanize();
});
Handlebars.registerHelper('sectionHighlight', function(section, options) {
	return (section === options.hash.name) ? new Handlebars.SafeString(' aria-selected="true"') : '';
});
Handlebars.registerHelper('dispBytes', function(bytes) {
	var i = 0;
	var byteUnits = ['B', 'KB', 'MB', 'GB', 'TB', 'PB', 'EB', 'ZB', 'YB'];
	do {
		bytes /= 1024;
		i++;
	} while (bytes > 1024);

	return new Handlebars.SafeString(Math.max(bytes, 0.1).toFixed(1) + byteUnits[i]);
});
Handlebars.registerHelper('lower', function(str) {
	return str.toLowerCase();
});


function getData(type) {
	var handlers = {
		fastly: function() {
			if (!process.env.FASTLY_SERVICE_ID) return Promise.reject("Fastly environment vars not set");
			return request({
				url: 'https://api.fastly.com/stats/service/' + process.env.FASTLY_SERVICE_ID + '?from=7 days ago&to=2 hours ago&by=hour',
				headers: { 'fastly-key': process.env.FASTLY_API_KEY },
			}).then(function (response) {
				var rollup = {requests:0, hits:0, miss:0, bandwidth:0};
				var data = (response && JSON.parse(response)) || {data:[]};
				var byhour = data.data.map(function(result) {
					rollup.requests += result.requests;
					rollup.hits += result.hits;
					rollup.miss += result.miss;
					rollup.bandwidth += result.bandwidth;
					return {date: result.start_time, requests:result.requests, hits:result.hits, miss:result.miss};
				});
				return {byhour:byhour, rollup:rollup};
			});
		},
		respTimes: function() {
			if (!process.env.PINGDOM_CHECK_ID) return Promise.reject("Pingdom environment vars not set");
			var to = ((new Date()).getTime()/1000) - 3600;
			var from = to - (60*60*24*7);
			return request({
				url: 'https://api.pingdom.com/api/2.0/summary.performance/' + process.env.PINGDOM_CHECK_ID + '?from='+from+'&to='+to+'&resolution=hour',
				headers: {
					'app-key': process.env.PINGDOM_API_KEY,
					'Account-Email': process.env.PINGDOM_ACCOUNT
				},
				auth: {
					user: process.env.PINGDOM_USERNAME,
					pass: process.env.PINGDOM_PASSWORD
				}
			}).then(function (response) {
				var data = (response && JSON.parse(response)) || [];
				if (!data.summary) {
					data = {summary:{hours:[]}};
				}
				return data.summary.hours.map(function(result) {
					return {date: result.starttime, respTime: result.avgresponse};
				});
			});
		},
		outages: function() {
			if (!process.env.PINGDOM_CHECK_ID) return Promise.reject("Pingdom environment vars not set");
			var to = ((new Date()).getTime()/1000) - 3600;
			var from = to - (60*60*24*365*5);
			return request({
				url: 'https://api.pingdom.com/api/2.0/summary.outage/' + process.env.PINGDOM_CHECK_ID + '?from='+from+'&to='+to+'&order=desc',
				headers: {
					'app-key': process.env.PINGDOM_API_KEY,
					'Account-Email': process.env.PINGDOM_ACCOUNT
				},
				auth: {
					user: process.env.PINGDOM_USERNAME,
					pass: process.env.PINGDOM_PASSWORD
				}
			}).then(function (response) {
				var data = (response && JSON.parse(response)) || {summary:{states:[]}};
				return data.summary.states.filter(function(result) {
					return (result.status !== 'unknown');
				}).map(function(result) {
					return {date:result.timefrom, status: result.status.toUpperCase(), duration: result.timeto-result.timefrom};
				}).slice(0,5);
			});
		},
		sizes: function() {
			var sizes = [];
			var zlib = require('zlib');
			var PolyfillSet = require('./PolyfillSet');
			var polyfillservice = require('../lib');
			var data = require('../docs/assets/compat.json');
			var firstfeature = data[Object.keys(data)[0]];
			Object.keys(firstfeature).forEach(function(family) {
				Object.keys(firstfeature[family]).forEach(function(version) {
					var minsrc = polyfillservice.getPolyfillString({
						features: PolyfillSet.fromQueryParam('default').get(),
						uaString:family+'/'+version,
						minify: true
					});
					sizes.push({
						family: family,
						ver: version,
						minsrc: minsrc,
						rawbytes: polyfillservice.getPolyfillString({
							features: PolyfillSet.fromQueryParam('default').get(),
							uaString:family+'/'+version,
							minify: false
						}).length,
						minbytes: minsrc.length
					});
				});
			});
			return Promise.all(sizes.map(function(item) {
				return new Promise(function(resolve, reject) {
					zlib.gzip(item.minsrc, function(err, gzipsrc) {
						if (!err) {
							item.gzipbytes = gzipsrc.length;
						}
						resolve(item);
					});
				});
			}));
		}
	};

	if (cache.hasOwnProperty(type) && cache[type].creationTime > ((new Date()).getTime() - (cachettl*1000)) ) {
		return cache[type].promise;
	} else {
		cache[type] = {creationTime: (new Date()).getTime()};
		try {
			return cache[type].promise = handlers[type]();
		} catch(err) {
			return cache[type].promise = Promise.reject(err.toString());
		};
	}
}

function getCompat() {
	var data = require('../docs/assets/compat.json');
	var sourceslib = sources.latest;
	var browsers = ['ie', 'firefox', 'chrome', 'safari', 'opera', 'ios_saf'];
	var msgs = {
		'native': 'Supported natively',
		'polyfilled': 'Supported with polyfill service',
		'missing': 'Not supported'
	};
	return Object.keys(data)
		.filter(function(feature) {
			return sourceslib.polyfillExists(feature) && feature.indexOf('_') !== 0;
		})
		.sort()
		.map(function(feat) {
			var polyfill = sourceslib.getPolyfill(feat);
			var fdata = {
				feature: feat,
				slug: feat.replace(/\./g, '_'),
				size: Object.keys(polyfill.variants).reduce(function(size, variantName) {
					return Math.max(size, polyfill.variants[variantName].minSource.length);
				}, 0),
				isDefault: (polyfill.aliases && polyfill.aliases.indexOf('default') !== -1),
				hasTests: polyfill.hasTests,
				docs: polyfill.docs,
				spec: polyfill.spec,
				notes: polyfill.notes ? polyfill.notes.map(function (n) { return marked(n); }) : [],
				license: polyfill.variants.default.license,
				licenseIsUrl: polyfill.variants.default.license && polyfill.variants.default.license.length > 5
			};
			browsers.forEach(function(browser) {
				if (data[feat][browser]) {
					fdata[browser] = [];
					Object.keys(data[feat][browser]).sort(function(a, b) {
						if (isNaN(a)) {
							return 1;
						} else if (isNaN(b)) {
							return -1;
						} else {
							return (parseFloat(a) < parseFloat(b)) ? -1 : 1;
						}
					}).forEach(function(version) {
						fdata[browser].push({
							status: data[feat][browser][version],
							statusMsg: msgs[data[feat][browser][version]],
							version: version
						});
					});
				}
			});
			return fdata;
		})
	;
}

// Quick helper for Promise.all to spread results over separate arguments rather than an array
function spread(fn) {
	return function(results) {
		fn.apply(fn, results);
	};
}

function route(req, res, next) {
	if (req.path.length < "/v1/docs/".length) {
		return res.redirect('/v1/docs/');
	}

	if (!req.params || !req.params[0]) {
		res.send(templates.index({section: 'index'}));

	} else if (req.params[0] === 'usage') {
		// Set the ttl to one hour for the usage page so the graphs are
		// updated more frequently, overriding the default cache-control
		// behaviour set in index.js
		var one_hour = 60 * 60;
		var one_week = one_hour * 24 * 7;
		res.set('Cache-Control', 'public, max-age=' + one_hour +', stale-while-revalidate=' + one_week + ', stale-if-error=' + one_week);
		Promise.all([getData('fastly'), getData('outages'), getData('respTimes')]).then(spread(function(fastly, outages, respTimes) {
			res.send(templates.usage({
				section: 'usage',
				requestsData: fastly.byhour,
				outages: outages,
				respTimes: respTimes,
				hitCount: fastly.rollup.hits,
				missCount: fastly.rollup.miss
			}));
		})).catch(function(rejectReason) {
			res.send(templates.usage({
				section: 'usage',
				msg: rejectReason.toString()
			}));
		});

	} else if (req.params[0] === 'features') {
		getData('sizes').then(function(sizes) {
			res.send(templates.compat({
				section: 'features',
				compat: getCompat(),
				sizes: sizes
			}));
		}).catch(console.error);

	} else if (req.params[0] === 'api') {
		res.send(templates.api({
			hasVersions: sources.listVersions().length > 1,
			versions: sources.listVersions(),
			section: 'api'
		}));

	} else if (req.params[0] === 'examples') {

		res.send(templates.examples({section: 'examples'}));

	} else if (req.params[0] === 'contributing') {
		res.send(templates.contributing({section: 'contributing', baselines: require('../lib/UA').getBaselines()}));

	} else {
		next();
	}
}

module.exports = {
	route: route
};
