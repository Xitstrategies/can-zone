var g = typeof WorkerGlobalScope !== "undefined" && (self instanceof WorkerGlobalScope)
	? self
	: typeof process !== "undefined" && {}.toString.call(process) === "[object process]"
	? global
	: window;

// Keep a local reference since we will be overriding this later.
var Promise = g.Promise;

var slice = Array.prototype.slice;

function Deferred(){
	var dfd = this;
	this.promise = new Promise(function(resolve, reject){
		dfd.resolve = resolve;
		dfd.reject = reject;
	});
}

var waitWithinRequest = g.canWait = g.canWait || function(fn, catchErrors){
	var request = waitWithinRequest.currentRequest;
	if(!request) return fn;
	request.waits++;

	return function(){
		return request.run(fn, this, arguments, catchErrors);
	};
};

waitWithinRequest.data = waitWithinRequest.data || function(dataOrPromise){
	var request = waitWithinRequest.currentRequest;
	if(!request) return dataOrPromise;
	var save = function(data){
		request.responses.push(data);
		return data;
	};
	if(dataOrPromise && dataOrPromise.then){
		return dataOrPromise.then(save);
	}
	return save(dataOrPromise);
};

waitWithinRequest.error = waitWithinRequest.error || function(error){
	var request = waitWithinRequest.currentRequest;
	if(!request) return error;
	request.errors.push(error);
	return error;
};

function Override(obj, name, fn) {
	this.old = obj[name];
	this.obj = obj;
	this.name = name;
	this.fn = fn(this.old, this);
}

Override.prototype.trap = function(){
	this.obj[this.name] = this.fn;
};

Override.prototype.release = function(){
	this.obj[this.name] = this.old;
};

canWait.Override = Override;

var allOverrides = [
	function(request){
		return new Override(g, "setTimeout", function(setTimeout){
			return function(fn, timeout){
				var callback = waitWithinRequest(function(){
					delete request.ids[timeoutId];
					return fn.apply(this, arguments);
				});
				var timeoutId = setTimeout.call(this, callback, timeout);
				request.ids[timeoutId] = true;
				return timeoutId;
			}
		});
	},

	function(request){
		return new Override(g, "clearTimeout", function(clearTimeout){
			return function(timeoutId){
				var ids = request.ids;
				if(ids[timeoutId]) {
					delete ids[timeoutId];
					request.waits--;

				}
				return clearTimeout.apply(this, arguments);
			};
		});
	},

	function(request){
		return new Override(g, "requestAnimationFrame", function(rAF){
			return function(fn){
				var callback = waitWithinRequest(fn);
				return rAF.call(this, callback);
			};
		});
	},

	function(request) {
		return new Override(g.Promise.prototype, "then", function(then){
			return function(onFulfilled, onRejected){
				var fn;
				var callback = waitWithinRequest(function(){
					if(fn) {
						return fn.apply(this, arguments);
					}
				}, false);

				var callWith = function(cb){
					return function(){
						fn = cb;
						return callback.apply(this, arguments);
					};
				};

				return then.call(this, callWith(onFulfilled),
								 callWith(onRejected));
			};
		});
	},

	function(request){
		return typeof XMLHttpRequest === "undefined" ?
			undefined :

		new Override(XMLHttpRequest.prototype, "send", function(send){
			return function(){
				var onreadystatechange = this.onreadystatechange,
					onload = this.onload,
					onerror = this.onerror,
					xhr = this;

				var request = waitWithinRequest.currentRequest;
				var callback = waitWithinRequest(function(ev){
					var xhr = ev.target;
					if(xhr.readyState === 4) {
						onreadystatechange && onreadystatechange.apply(xhr, arguments);
						if(onload && !xhr.__onloadCalled) {
							onload.apply(xhr, arguments);
							xhr.__onloadCalled = true;
						}
					} else {
						request.waits++;
					}
				});
				this.onreadystatechange = callback;
				this.onerror = function(err){
					request.errors.push(err);
					onerror && onerror.apply(this, arguments);
				};

				return send.apply(this, arguments);
			};
		});
	},

	function(request){
		return typeof process === "undefined" || !process.nextTick ?
			undefined :

		new Override(process, "nextTick", function(nextTick){
			return function(fn/*, ...args */){
				var callback = waitWithinRequest(fn);
				var args = slice.call(arguments, 1);
				args.unshift(callback);
				return nextTick.apply(process, args);
			};
		});
	}

];


function Request(options) {
	this.deferred = new Deferred();
	this.waits = 0;
	this.ids = {};
	this.errors = [];
	this.responses = [];
	var o = this.overrides = [], def;

	var localOverrides = ((options && options.overrides)||[])
		.concat(allOverrides);

	for(var i = 0, len = localOverrides.length; i < len; i++) {
		def = localOverrides[i](this);
		if(def)
			o.push(def);
	}
}

Request.prototype.trap = function(){
	waitWithinRequest.previousRequest = waitWithinRequest.currentRequest;
	waitWithinRequest.currentRequest = this;
	var o = this.overrides;
	for(var i = 0, len = o.length; i < len; i++) {
		o[i].trap();
	}
};

Request.prototype.release = function(){
	var o = this.overrides;
	for(var i = 0, len = o.length; i < len; i++) {
		o[i].release();
	}
	waitWithinRequest.currentRequest = waitWithinRequest.previousRequest;
	waitWithinRequest.previousRequest = undefined;
};

Request.prototype.end = function(){
	var dfd = this.deferred;
	if(this.errors.length) {
		dfd.reject(this.errors);
	} else if(this.responses.length) {
		dfd.resolve(this.responses);
	} else {
		dfd.resolve();
	}
};

Request.prototype.run = function(fn, ctx, args, catchErrors){
	var res, error;
	try {
		res = this.runWithinScope(fn, ctx, args, catchErrors);
	} catch(err) {
		error = err;
	}
	this.waits--;
	if(this.waits === 0) {
		this.end();
	}
	if(error)
		throw error;
	return res;
};

Request.prototype.runWithinScope = function(fn, ctx, args, catchErrors){
	this.trap();

	var res;
	try {
		res = fn.apply(ctx, args);
		this.release();
	} catch(err) {
		this.release();
		if(catchErrors !== false) {
			this.errors.push(err);
		} else {
			throw err;
		}
	}

	return res;
};

function canWait(fn, options) {
	var request = new Request(options);

	// Call the function
	request.runWithinScope(fn);

	return request.deferred.promise;
}

if(typeof module !== "undefined" && module.exports) {
	module.exports = canWait;
}
