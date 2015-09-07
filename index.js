'use strict';

var got = require('got');
var qs = require('querystring');
var camelCase = require('camelcase');
var objectAssign = require('object-assign');
var filterObj = require('filter-obj');
var vkUtil = require('vk-api-util');
var CollectStream = require('./lib/collect-stream');
var Execution = require('./lib/execution');
var defaults = require('./defaults.json');

module.exports = VK;

function VK(app, opts, session) {
	if (!(this instanceof VK)) {
		return new VK(opts);
	}

	this.app = objectAssign(defaults.app, app);

	if (this.app.scope instanceof Array) {
		this.app.scope = this.app.scope.join(',');
	}

	this.opts = objectAssign(defaults.options, opts);
	this.session = session || {};

	this._deferred = [];
}

VK.prototype.setSession = function (data) {
	this.session = {
		token: data.access_token,
		userId: data.user_id,
		expires: (data.expires_in === 0) ? 0 : Date.now() + data.expires_in * 1000
	};

	return this;
};

VK.prototype.getSession = function () {
	return this.session;
};

VK.prototype.getToken = function () {
	return (this.hasValidToken()) ? this.session.token : undefined;
};

VK.prototype.hasValidToken = function (session) {
	session = session || this.session;

	return Boolean(session) && (session.expires === 0 || session.expires > Date.now());
};

VK.prototype._prepareAuthQuery = function (query, includeSecret) {
	query = query || {};

	var options = [
		'client_id',
		'redirect_uri',
		'scope',
		'v'
	];

	if (includeSecret || false) {
		options.push('client_secret');
	}

	query = supplyQuery(query, this.app, options);

	return query;
};

VK.prototype.renderAuthUrl =
VK.prototype.authUrl = function (query) {
	query = this._prepareAuthQuery(query);

	return [defaults.endpoints.auth, qs.stringify(query)].join('?');
};

VK.prototype._performAuth = function (query, callback) {
	var _this = this;

	var promise = got(defaults.endpoints.token, this._gotOptions({
		query: query
	}))
	.then(function (res) {
		_this.setSession(res.body);

		if (typeof callback === 'function') {
			callback(null, res.body, res);
		}

		return res;
	});

	return (typeof callback === 'function') ? this : promise;
};

VK.prototype.performSiteAuth =
VK.prototype.siteAuth = function (query, callback) {
	if (!query || typeof query['code'] === 'undefined') {
		throw new Error('Authorization Code Flow requires CODE parameter');
	}

	query = this._prepareAuthQuery(query, true);

	return this._performAuth(query, callback);
};

VK.prototype.performServerAuth =
VK.prototype.serverAuth = function (query, callback) {
	query = this._prepareAuthQuery(query, false);

	query['grant_type'] = 'client_credentials';

	return this._performAuth(query, callback);
};

VK.prototype.performApiCall =
VK.prototype.apiCall = function (method, query, callback) {
	if (typeof method !== 'string') {
		throw new Error('Method name should be a string');
	}

	if (!vkUtil.isMethod(method)) {
		throw new Error('Unknown method');
	}

	if (!this.hasInScope(method)) {
		throw new Error('Method "' + method + '" is not in your application\'s scope');
	}

	if (!vkUtil.isOpenMethod(method) && !this.hasValidToken()) {
		throw new Error('Token is expired or not set');
	}

	if (typeof query === 'function') {
		callback = query;
	}

	query = (typeof query === 'object') ? query : {};

	query['v'] = query['v'] || this.app.v;

	if (!vkUtil.isOpenMethod(method)) {
		query['access_token'] = this.session.token;
	}

	var url = [defaults.endpoints.methods, method].join('/');

	var _this = this;

	var promise = this._enqueue().then(function () {
		got.post(url, _this._gotOptions({query: query}), callback);
	});

	return (typeof callback === 'function') ? this : promise;
};

VK.prototype.execution = function () {
	return new Execution(this);
};

VK.prototype.collectStream = function (method, query) {
	return new CollectStream(this, method, query);
};

VK.prototype.collect = function (method, query, callback) {
	var stream = this.collectStream(method, query);

	var promise = new Promise(function (resolve, reject) {
		var stored = {
			items: []
		};

		stream
		.on('data', function (data) {
			data.items = stored.items.concat(data.items);
			stored = objectAssign(stored, data);
		})
		.on('error', function (err) {
			reject(err);
			if (typeof callback === 'function') {
				callback(err, null);
			}
		})
		.on('end', function () {
			resolve(stored);
			if (typeof callback === 'function') {
				callback(null, stored);
			}
		});
	});

	promise.stream = stream;

	return (typeof callback === 'function') ? this : promise;
};

VK.prototype.hasInScope = function (method) {
	return vkUtil.isMethodInScope(method, this.app.scope);
};

VK.prototype._canCall = function () {
	var now = new Date();
	this.nextCall = this.nextCall || now;
	return !(this.nextCall > now);
};

VK.prototype._enqueue = function () {
	var remains = 0;

	if (!this._canCall()) {
		remains = this.nextCall - new Date();
		this.nextCall = new Date(this.nextCall.valueOf() + this.opts.interval);
	} else {
		this.nextCall = new Date(Date.now() + this.opts.interval);
	}

	return new Promise(function (resolve) {
		setTimeout(resolve, remains);
	});
};

VK.prototype._gotOptions = function (opts) {
	return objectAssign(defaults.got, filterObj(this.opts, [
		'timeout',
		'headers'
	]), opts);
};

function supplyQuery(query, source, opts) {
	opts.forEach(function (option) {
		if (!query[option]) {
			if (typeof source[camelCase(option)] !== 'undefined') {
				query[option] = source[camelCase(option)];
			} else {
				throw new Error('Please supply "' + option + '" option');
			}
		}
	});

	return query;
}
