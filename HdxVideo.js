'use strict';

/** @const */
var DEBUG_ONLY = false;

var hdxMediaStream = {};
hdxMediaStream.foundVideos = [];
hdxMediaStream.pendingVideos = [];
hdxMediaStream.redirectedVideos = {}; //associative array
hdxMediaStream.videoidx = 0;

hdxMediaStream.origAddEventListener = null;
hdxMediaStream.origRemoveEventListener = null;
hdxMediaStream.origDispatchEvent = null;

hdxMediaStream.stringifyArray = function(arr) {
	var str = '[';
	for (var i = 0; i < arr.length; ++i)
	{
		if (i != 0)
			str += ',';
		str += hdxMediaStream.stringify(arr[i]);
	}
	str += ']';
	return str;
};

hdxMediaStream.stringifyObject = function(obj) {
	var str = '{';
	var first = true;
	for (var prop in obj)
	{
		if (first)
			first = false;
		else
			str = str + ',';

		str = str + '"' + prop + '":';
		if (obj[prop] instanceof Array)
			str = str + hdxMediaStream.stringifyArray(obj[prop]);
		else if (typeof obj[prop] == 'object')
			str = str + hdxMediaStream.stringifyObject(obj[prop]);
		else
			str = str + JSON.stringify(obj[prop]);
	}
	str = str + '}';

	return str;
};

hdxMediaStream.stringify = function(v) {
	if (typeof v == 'object')
		return hdxMediaStream.stringifyObject(v);
	else
		return JSON.stringify(v);
};

hdxMediaStream.setWindowTitle = function(title, sender) {
	if ((!window.parent) || (window == window.parent))
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] setWindowTitle: ' + title);
		if (title)
		{ // enqueue or set title
			// save original title
			if (!hdxMediaStream.oldTitle)
			{
				hdxMediaStream.oldTitle = document.title;
				hdxMediaStream.pendingTitles = [];
				document.title = title;
				sender.postMessage({ /**@expose*/ msgtype: 'winid', /**@expose*/ parameter: undefined}, '*');
			}
			else
			{ // we already have a title... enqueue this one
				hdxMediaStream.pendingTitles.push({title: title, sender: sender});
			}
		}
		else
		{ // move to next available title, or return to original title.
			if (hdxMediaStream.pendingTitles.length)
			{
				if (DEBUG_ONLY)
					console.log('[HdxVideo.js] setWindowTitle: Titles remain: ' + hdxMediaStream.pendingTitles.length);
				var nextItem = hdxMediaStream.pendingTitles.shift();
				document.title = nextItem.title;
				nextItem.sender.postMessage({msgtype: 'winid', parameter: undefined}, '*'); //reply to sender
			}
			else
			{
				if (DEBUG_ONLY)
					console.log('[HdxVideo.js] setWindowTitle: No titles remain.  Reverting to original title.');
				document.title = hdxMediaStream.oldTitle;
				hdxMediaStream.oldTitle = undefined;
			}
		}
	}
	else
	{
		// send a message to the top window
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] setWindowTitle (referring action to parent): ' + title);
		window.top.postMessage({msgtype: 'title', parameter: title}, '*');
	}
};

// This listener routine allows for communication between parent window and child iframes across
// domains.  We use it as the normal channel for the setWindowTitle() routine to acknowledge that
// a window title has been successfully set, regardless of whether we're in an iframe or not.
window.addEventListener('message', function(messageEvent) {
	//console.log('[HdxVideo.js] onMessage type: ' + messageEvent['data']['msgtype'] + ' param: ' + messageEvent['data']['parameter']);

	if (!messageEvent['data'] || !messageEvent['data']['msgtype']) {
		// message probably not meant for us
	} else if (messageEvent['data']['msgtype'] == 'title') {
		hdxMediaStream.setWindowTitle(messageEvent['data']['parameter'], messageEvent.source);
	} else if (messageEvent['data']['msgtype'] == 'winid') {
		hdxMediaStream.WSSendObject({
			/**@expose*/ v: 'winid'
		});
	} else if (messageEvent['data']['msgtype'] == 'getOrigin') {
		if (!hdxMediaStream.boundingRectListeners)
			hdxMediaStream.boundingRectListeners = [];
		if (hdxMediaStream.boundingRectListeners.indexOf(messageEvent.source) == -1)
			hdxMediaStream.boundingRectListeners.push(messageEvent.source);

		if ((!window.parent) || (window == window.parent)) {
			// root window
			hdxMediaStream.origin = {left: 0, top: 0};

			var frameElements = document.getElementsByTagName('iframe');
			for (var i = 0; i < frameElements.length; ++i) {
				if (frameElements[i].contentWindow == messageEvent.source) {
					var r = hdxMediaStream.getFrameInsideRect(frameElements[i]);
					messageEvent.source.postMessage({msgtype: 'setOrigin', parameter: {left: r.left, top: r.top}}, '*');
					if (DEBUG_ONLY)
						console.log('[HdxVideo.js] Posted origin to child.');
					messageEvent.source.postMessage({msgtype: 'visibleRegion', parameter: hdxMediaStream.createRgnForBoundingRect(r)}, '*');
				}
			}

		} else {
			// child window... asks parentwindow for updated origin
			window.parent.postMessage({msgtype: 'getOrigin', parameter: false}, '*');
		}
	} else if (messageEvent['data']['msgtype'] == 'setOrigin') {
		if ((!hdxMediaStream.origin) ||
		(hdxMediaStream.origin.left != messageEvent['data']['parameter'].left) ||
		(hdxMediaStream.origin.top != messageEvent['data']['parameter'].top)) {

			hdxMediaStream.origin = messageEvent['data']['parameter'];
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] New origin: {' + hdxMediaStream.origin.left + ', ' + hdxMediaStream.origin.top + '}');

			if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
				hdxMediaStream.WSSendObject({
					/**@expose*/ v: 'origin',
					/**@expose*/ x: hdxMediaStream.origin.left,
					/**@expose*/ y: hdxMediaStream.origin.top
				});
			}
			hdxMediaStream.onOriginChanged();
			hdxMediaStream.onRegionChanged();
		}
	} else if (messageEvent['data']['msgtype'] == 'visibleRegion') {
		//console.log('[HdxVideo.js] Message: visibleRegion');
		if ((!hdxMediaStream.region) ||
			(hdxMediaStream.region.left != messageEvent['data']['parameter'].left) ||
			(hdxMediaStream.region.top != messageEvent['data']['parameter'].top) ||
			(hdxMediaStream.region.right != messageEvent['data']['parameter'].right) ||
			(hdxMediaStream.region.bottom != messageEvent['data']['parameter'].bottom)) {

			hdxMediaStream.region = messageEvent['data']['parameter'];

			var sendRegion = hdxMediaStream.insetRect(hdxMediaStream.region, 0, 0, 0, 0); // make a copy of the region
			sendRegion.right = Math.min(sendRegion.right, document.documentElement.clientWidth); // and clip our region to our internal window area (removing scrollbars)
			sendRegion.bottom = Math.min(sendRegion.bottom, document.documentElement.clientHeight);
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] New region: {' + sendRegion.left + ', ' + sendRegion.top + ', ' +
					sendRegion.right + ', ' + sendRegion.bottom + '}');

			if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
				hdxMediaStream.WSSendObject({
					/**@expose*/ v: 'region',
					/**@expose*/ x1: sendRegion.left,
					/**@expose*/ y1: sendRegion.top,
					/**@expose*/ x2: sendRegion.right,
					/**@expose*/ y2: sendRegion.bottom
				});
			}
			hdxMediaStream.onRegionChanged();
		}
	} else if (messageEvent['data']['msgtype'] == 'getClientScreenOffset') {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Message: getClientScreenOffset');

		if (!hdxMediaStream.boundingRectListeners)
			hdxMediaStream.boundingRectListeners = [];
		if (hdxMediaStream.boundingRectListeners.indexOf(messageEvent.source) == -1)
			hdxMediaStream.boundingRectListeners.push(messageEvent.source);

		var child_cso = messageEvent['data']['parameter'];
		var frameElements = document.getElementsByTagName('iframe');
		for (var i = 0; i < frameElements.length; ++i) {
			if (frameElements[i].contentWindow == messageEvent.source) {
				var child_r = hdxMediaStream.getFrameInsideRect(frameElements[i]);
				hdxMediaStream.sendLocalClientScreenOffset({left: child_cso.left - child_r.left,
					top: child_cso.top - child_r.top});
			}
		}
	} else if (messageEvent['data']['msgtype'] == 'setClientScreenOffset') {
		hdxMediaStream.sendGlobalClientScreenOffset(messageEvent['data']['parameter']);
	} else if (DEBUG_ONLY) {
		console.log('[HdxVideo.js] Unknown message type: ' + messageEvent['data']['msgtype']);
	}
}, false);


hdxMediaStream.onWSMessage = function(messageEvent) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] <<< ' + messageEvent['data']);
	var v = JSON.parse(messageEvent['data']);
	if (v['v'] == 'winid')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: winid: ' + v['title']);
		hdxMediaStream.setWindowTitle(v['title'], window);
	}
	else if (v['v'] == 'play')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: play: ' + v['id']);
		hdxMediaStream.OnPlayNotification(v['id']);
	}
	else if (v['v'] == 'pause')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: pause: ' + v['id']);
		hdxMediaStream.OnPauseNotification(v['id']);
	}
	else if (v['v'] == 'eos')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: eos: ' + v['id']);
		hdxMediaStream.OnEOSNotification(v['id']);
	}
	else if (v['v'] == 'time')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: time: ' + v['id'] + ' - ' + v['time']);
		hdxMediaStream.OnTimeNotification(v['id'], v['time']);
	}
	else if (v['v'] == 'buffered')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: buffered: ' + v['id'] + ' - ' + v['ranges']);
		hdxMediaStream.OnBufferedNotification(v['id'], v['ranges']);
	}
	else if (v['v'] == 'error')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: error: ' + v['id']);
		hdxMediaStream.OnErrorNotification(v['id'], v['svrender']);
	}
	else if (v['v'] == 'vidsz')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: vidsz: ' + v['id'] + ' - ' + v['w'] + 'x' + v['w']);
		hdxMediaStream.OnVideoSizeNotification(v['id'], v['w'], v['h']);
	}
	else if (v['v'] == 'duration')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: duration: ' + v['id'] + ' - ' + v['value']);
		hdxMediaStream.OnDurationNotification(v['id'], v['value']);
	}
	else if (v['v'] == 'canplaythrough')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: canplaythrough: ' + v['id']);
		hdxMediaStream.OnCanPlaythroughNotification(v['id']);
	}
	else if (v['v'] == 'src')
	{
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] onWSMessage: src: ' + v['id'] + ' - ' + v['src']);
		hdxMediaStream.OnSrcNotification(v['id'], v['src']);
	}
	else if (DEBUG_ONLY)
	{
		console.log('[HdxVideo.js] onWSMessage: Unknown message received!');
	}
};

hdxMediaStream.onWSOpen = function() {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] onWSOpen:');

	hdxMediaStream.getOrigin();
	hdxMediaStream.onVisibilityChange();
	hdxMediaStream.onResize();
};

hdxMediaStream.onWSClose = function(closeEvent) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] onWSClose: code=' + closeEvent.code + ' clean=' + closeEvent.wasClean + ' ' + closeEvent.reason);
	hdxMediaStream.suspendRedirection();
};

hdxMediaStream.onWSError = function() {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] onWSError:');
	hdxMediaStream.suspendRedirection();
};

hdxMediaStream.WSSendObject = function(obj) {
	var strObj = hdxMediaStream.stringify(obj);
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] >>> ' + strObj);
	hdxMediaStream.websocket.send(strObj);
};

hdxMediaStream.suspendRedirection = function() {
	for (var key in hdxMediaStream.redirectedVideos) {
		hdxMediaStream.redirectedVideos[key].hdxvid.setError(2); // MEDIA_ERR_NETWORK
		hdxMediaStream.redirectedVideos[key].hdxvid.unhook(true);
		delete hdxMediaStream.redirectedVideos[key].hdxvid;
		hdxMediaStream.pendingVideos = hdxMediaStream.pendingVideos.concat(hdxMediaStream.redirectedVideos[key]);
	}
	hdxMediaStream.redirectedVideos = {};

	for (var key in hdxMediaStream.pendingVideos) { // unhook pending videos, too.
		if (hdxMediaStream.pendingVideos[key].hdxEventHandlerHook)
			hdxMediaStream.pendingVideos[key].hdxEventHandlerHook.unintercept();
	}
}

hdxMediaStream.printWindowPosition = function() {
	// print "screen" position of actual window.
	//console.log('[HdxVideo.js] Window: (' + ((window.screenLeft) ? (window.screenLeft) : (window.screenX)) + ', ' + ((window.screenTop) ? (window.screenTop) : (window.screenY)) + ')');
};

hdxMediaStream.sendEvent = function(vid, evtName) {
	try {
		var evt = document.createEvent('Event');
		evt.initEvent(evtName, true, true);
		vid.dispatchEvent(evt);
	} catch (ex) {
		console.log('[HdxVideo.js] exception dispatching "' + evtName + '" event: ' + ex.message);
	}
};

hdxMediaStream.OnPlayNotification = function(videoid) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnPlayNotification: initiated playback...');
		if (vid.hdxvid.paused && this.reqstate == '')
			hdxMediaStream.sendEvent(vid, 'play'); // server-initiated
		if (this.reqstate == 'play')
			this.reqstate = ''; // got the response we were expecting
		vid.hdxvid.paused = false;
		vid.hdxvid.playing = true;
		vid.hdxvid.ended = false;
		vid.hdxvid.hasPlayedOnce = true;
		vid.hdxvid.resyncTimer();
		hdxMediaStream.sendEvent(vid, 'playing');
	}
};

hdxMediaStream.OnPauseNotification = function(videoid) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnPauseNotification: pausing playback...');
		if (!vid.hdxvid.paused && this.reqstate == '')
			hdxMediaStream.sendEvent(vid, 'pause'); // server-initiated
		if (this.reqstate == 'pause')
			this.reqstate == ''; // got the response we were expecting
		vid.hdxvid.paused = true;
		vid.hdxvid.playing = false;
		vid.hdxvid.resyncTimer();
	}
};

hdxMediaStream.OnEOSNotification = function(videoid) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnEOSNotification: ended playback...');
		vid.hdxvid.paused = true;
		vid.hdxvid.playing = false;
		vid.hdxvid.ended = true;
		hdxMediaStream.sendEvent(vid, 'pause');
		hdxMediaStream.sendEvent(vid, 'ended');
		if (vid.loop)
			vid.play();
		else
			vid.hdxvid.resyncTimer();
	}
};

hdxMediaStream.OnTimeNotification = function(videoid, time) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnTimeNotification: ' + time);
		vid.hdxvid.reportedPosition = time;
		vid.hdxvid.reportedPositionTime = new Date();
		vid.hdxvid.resyncTimer();
		hdxMediaStream.sendEvent(vid, 'timeupdate');
	}
};

hdxMediaStream.OnBufferedNotification = function(videoid, ranges) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnBufferedNotification: ' + ranges);
		vid.hdxvid.reportedBufferedRanges = ranges;
		hdxMediaStream.sendEvent(vid, 'progress');
	}
};

hdxMediaStream.OnErrorNotification = function (videoid, svrender) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnErrorNotification: ' + svrender);
		if (!svrender) {
			hdxMediaStream.sendEvent(vid, 'error');
			hdxMediaStream.sendEvent(vid, 'abort');
		}
		vid.hdxvid.unhook(svrender);
	}
};

hdxMediaStream.recomputeSize = function(hdxvid) {
	if (typeof hdxvid.attrWidth === 'undefined' && typeof hdxvid.attrHeight === 'undefined') {
		hdxvid.computedWidth = hdxvid.videoWidth;
		hdxvid.computedHeight = hdxvid.videoHeight;
	} else if (typeof hdxvid.attrWidth === 'undefined') {
		hdxvid.computedWidth = hdxvid.attrHeight * hdxvid.videoWidth / (hdxvid.videoHeight ? hdxvid.videoHeight : 1);
		hdxvid.computedHeight = hdxvid.attrHeight;
	} else if (typeof hdxvid.attrHeight === 'undefined') {
		hdxvid.computedWidth = hdxvid.attrWidth;
		hdxvid.computedHeight = hdxvid.attrWidth * hdxvid.videoHeight / (hdxvid.videoWidth ? hdxvid.videoWidth : 1);
	} else {
		hdxvid.computedWidth = hdxvid.attrWidth;
		hdxvid.computedHeight = hdxvid.attrHeight;
	}

	hdxvid.origProps.width.set.bind(hdxvid.target)(hdxvid.computedWidth);
	hdxvid.origProps.height.set.bind(hdxvid.target)(hdxvid.computedHeight);

	hdxMediaStream.sendEvent(hdxvid.target, 'resize');
};

hdxMediaStream.OnVideoSizeNotification = function(videoid, width, height) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnVideoSizeNotification:');
		vid.hdxvid.videoWidth = width;
		vid.hdxvid.videoHeight = height;

		hdxMediaStream.recomputeSize(vid.hdxvid);
	}
};

hdxMediaStream.OnDurationNotification = function(videoid, duration) {
//hdxMediaStream.OnVideoSizeNotification(videoid, 600, 600);
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnDurationNotification:');
		vid.hdxvid.duration = duration;
		hdxMediaStream.sendEvent(vid, 'durationchange');

		vid.hdxvid.makeVisible(true);
	}
};

hdxMediaStream.OnCanPlaythroughNotification = function(videoid) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnCanPlaythroughNotification:');
		hdxMediaStream.sendEvent(vid, 'loadedmetadata');
		hdxMediaStream.sendEvent(vid, 'loadeddata');
		hdxMediaStream.sendEvent(vid, 'progress');
		hdxMediaStream.sendEvent(vid, 'canplay');
		hdxMediaStream.sendEvent(vid, 'canplaythrough');
	}
};

hdxMediaStream.OnSrcNotification = function(videoid, src) {
	var vid = hdxMediaStream.redirectedVideos[videoid];
	if (vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] OnSrcNotification:');
		vid.hdxvid.currentSrc = src;
	}
}

hdxMediaStream.redirectVideo = function(video) {
	var idx = ++hdxMediaStream.videoidx;
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] redirectVideo(): ' + idx);
	hdxMediaStream.redirectedVideos[idx] = video;

	// commit to discarding the events we've already captured, and all future events until we unhook.
	if (video.hdxEventHandlerHook)
		video.hdxEventHandlerHook.discardCapturedEvents();

	hdxMediaStream.WSSendObject({
		/**@expose*/ v: 'add',
		/**@expose*/ id: idx
	});

	var proxy = new HdxVideo(video, idx);

	var attrSource = video.hdxvid.origSrc;
	if (attrSource) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Video ' + idx + ' source (attr): ' + attrSource);

		hdxMediaStream.WSSendObject({
			/**@expose*/ v: 'src',
			/**@expose*/ id: idx,
			/**@expose*/ src: attrSource,
			/**@expose*/ type: video.getAttribute('type')
		});
	}

	var sources = video.getElementsByTagName('source');
	for (var i = 0; i < sources.length; i++) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Video ' + idx + ' source (element): ' + sources[i].src);

		hdxMediaStream.WSSendObject({
			/**@expose*/ v: 'src',
			/**@expose*/ id: idx,
			/**@expose*/ src: sources[i].src,
			/**@expose*/ type: sources[i].getAttribute('type')
		});
	}

	hdxMediaStream.sendEvent(video, 'loadstart');

	hdxMediaStream.WSSendObject({
		/**@expose*/ v: 'srcset',
		/**@expose*/ id: idx
	});

	hdxMediaStream.WSSendObject({
		/**@expose*/ v: 'controls',
		/**@expose*/ id: idx,
		/**@expose*/ controls: !!(proxy.controls)
	});

	if (video.autoplay)
		proxy.target.play();
};

hdxMediaStream.printVideoPositions = function() {
	var i;
	for (i = 0; i < hdxMediaStream.pendingVideos.length; )
	{
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
			hdxMediaStream.redirectVideo(hdxMediaStream.pendingVideos[i]);
			hdxMediaStream.pendingVideos.splice(i, 1);
		} else {
			i++;
		}
	}

	for (var key in hdxMediaStream.redirectedVideos)
	{
		var vid = hdxMediaStream.redirectedVideos[key];
		var videoRect = hdxMediaStream.getVideoClientRect(vid);

		var pixelRatio = hdxMediaStream.getPixelRatio();

		if (videoRect.left != vid.hdxvid.lastPos.left ||
			videoRect.top != vid.hdxvid.lastPos.top ||
			videoRect.width != vid.hdxvid.lastPos.width ||
			videoRect.height != vid.hdxvid.lastPos.height ||
			pixelRatio != vid.hdxvid.lastPixelRatio)
		{
			vid.hdxvid.lastPos = videoRect;
			vid.hdxvid.lastPixelRatio = pixelRatio;

			// print "document-client" position of element:
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] Video[' + key + ']: ((' + videoRect.left + ', ' + videoRect.top + '), (' + (videoRect.right - videoRect.left) + ', ' + (videoRect.bottom - videoRect.top) + '))');

			var videoRectScaled = hdxMediaStream.scaleRect(videoRect, pixelRatio);

			// or: videoRect2 = {left: videoRect.left, top: videoRect.top, width: videoRect.width, height: videoRect.height};

			if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
				hdxMediaStream.WSSendObject({
					/**@expose*/ v: 'pos',
					/**@expose*/ id: vid.hdxvid.videoid,
					/**@expose*/ rect: videoRectScaled
				});
			}
		}
	}
};

hdxMediaStream.rectToString = function(r) {
	return '{{' + r.left + ', ' + r.top + '}, {' + r.right + ', ' + r.bottom + '}} (' + r.width + ', ' + r.height + ')';
};

hdxMediaStream.subtractRects = function(r1, r2) {
	var rv = [];

	var topRect = {
		left: r1.left,
		top: r1.top,
		right: r1.right,
		bottom: Math.min(r1.bottom, r2.top)
	};
	topRect.width = topRect.right - topRect.left;
	topRect.height = topRect.bottom - topRect.top;
	//console.log('[HdxVideo.js]    Top: ' + hdxMediaStream.rectToString(topRect));
	if (topRect.width > 0 && topRect.height > 0)
		rv.push(topRect);

	var leftRect = {
		left: r1.left,
		top: Math.max(r1.top, r2.top),
		right: Math.min(r1.right, r2.left),
		bottom: Math.min(r1.bottom, r2.bottom)
	};
	leftRect.width = leftRect.right - leftRect.left;
	leftRect.height = leftRect.bottom - leftRect.top;
	//console.log('[HdxVideo.js]   Left: ' + hdxMediaStream.rectToString(leftRect));
	if (leftRect.width > 0 && leftRect.height > 0)
		rv.push(leftRect);

	var bottomRect = {
		left: r1.left,
		top: Math.max(r1.top, r2.bottom),
		right: r1.right,
		bottom: r1.bottom
	};
	bottomRect.width = bottomRect.right - bottomRect.left;
	bottomRect.height = bottomRect.bottom - bottomRect.top;
	//console.log('[HdxVideo.js] Bottom: ' + hdxMediaStream.rectToString(bottomRect));
	if (bottomRect.width > 0 && bottomRect.height > 0)
		rv.push(bottomRect);

	var rightRect = {
		left: Math.max(r1.left, r2.right),
		top: Math.max(r1.top, r2.top),
		right: r1.right,
		bottom: Math.min(r1.bottom, r2.bottom)
	};
	rightRect.width = rightRect.right - rightRect.left;
	rightRect.height = rightRect.bottom - rightRect.top;
	//console.log('[HdxVideo.js]  Right: ' + hdxMediaStream.rectToString(rightRect));
	if (rightRect.width > 0 && rightRect.height > 0)
		rv.push(rightRect);

	//console.log('[HdxVideo.js]     ' + hdxMediaStream.rectToString(r1));
	//console.log('[HdxVideo.js]    -' + hdxMediaStream.rectToString(r2));
	//for (var i in rv)
	//	console.log('[HdxVideo.js]    =' + hdxMediaStream.rectToString(rv[i]));

	return rv; // r1 - r2
};

hdxMediaStream.intersectRects = function(r1, r2) {
	var rv = {
		left: r1.left > r2.left ? r1.left : r2.left,
		right: r1.right < r2.right ? r1.right : r2.right,
		top: r1.top > r2.top ? r1.top : r2.top,
		bottom: r1.bottom < r2.bottom ? r1.bottom : r2.bottom
		};
	rv.width = rv.right - rv.left;
	rv.height = rv.bottom - rv.top;
	return (rv.width > 0 && rv.height > 0) ? rv : null;
};

hdxMediaStream.rectListSubtractRect = function(rList, r) {
	var rv = {intersected: false, rects: []};

	for (var i = 0; i < rList.length; ++i)
	{
		var rects = hdxMediaStream.subtractRects(rList[i], r);
		rv.rects = rv.rects.concat(rects);
		if (rects.length == 1) {
			if (rects[0].width != rList[i].width || rects[0].height != rList[i].height)
				rv.intersected = true;
		} else {
			rv.intersected = true;
		}
	}

	return rv;
};

hdxMediaStream.consolidateRegions = function(clipList) {
	var rv = clipList;

	if (rv.length > 1)
	{
		var keepsorting = true;
		while (keepsorting)
		{
			keepsorting = false;

			// sort horizontal, then vertical
			rv.sort(function(a, b) {
				return (a.left != b.left) ? (a.left - b.left) : (a.top - b.top);
				});

			// merge all the rectangles
			var newList = [];
			var prevRect = rv[0];
			for (var i = 1; i < rv.length; ++i)
			{
				if (prevRect.left == rv[i].left && prevRect.width == rv[i].width && prevRect.bottom == rv[i].top)
				{
					//merge
					prevRect.bottom = rv[i].bottom;
					prevRect.height = prevRect.bottom - prevRect.top;
					keepsorting = true;
				}
				else
				{
					newList.push(prevRect);
					prevRect = rv[i];
				}
			}
			newList.push(prevRect);
			rv = newList;

			// sort vertical, then horizontal
			rv.sort(function(a, b) {
				return (a.top != b.top) ? (a.top - b.top) : (a.left - b.left);
				});

			// merge all the rectangles
			newList = [];
			prevRect = rv[0];
			for (var i = 1; i < rv.length; ++i)
			{
				if (prevRect.top == rv[i].top && prevRect.height == rv[i].height && prevRect.right == rv[i].left)
				{
					//merge
					prevRect.right = rv[i].right;
					prevRect.width = prevRect.right - prevRect.left;
					keepsorting = true;
				}
				else
				{
					newList.push(prevRect);
					prevRect = rv[i];
				}
			}
			newList.push(prevRect);
			rv = newList;
		}
	}

	return rv;
};

hdxMediaStream.sendRegions = function(vid, clipList) {
	var pixelRatio = hdxMediaStream.getPixelRatio();
	var scaledClipList = [];
	for (var i = 0; i < clipList.length; ++i)
		scaledClipList.push(hdxMediaStream.scaleRect(clipList[i], pixelRatio));

	var send = false;
	if (!vid.hdxvid.regions || vid.hdxvid.regions.length != scaledClipList.length)
	{
		send = true;
	}
	else
	{
		for (var i = 0; i < scaledClipList.length; ++i)
		{
			var r1 = vid.hdxvid.regions[i];
			var r2 = scaledClipList[i];
			if (r1.left != r2.left || r1.top != r2.top || r1.width != r2.width || r1.height != r2.height)
			{
				send = true;
				break;
			}
		}
	}

	if (send && hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
	{
		hdxMediaStream.WSSendObject({
			/**@expose*/ v: 'clip',
			/**@expose*/ id: vid.hdxvid.videoid,
			/**@expose*/ c: scaledClipList
		});
		vid.hdxvid.regions = scaledClipList;
	}
};

hdxMediaStream.drawRegions = function(rect, regions) {

	var regionsDiv = document.getElementById('divRegions');
	if (regionsDiv)
	{
		while (regionsDiv.firstChild)
			regionsDiv.removeChild(regionsDiv.firstChild);

		var drawDiv = document.createElement('div');
		drawDiv.style.width = rect.width + 'px';
		drawDiv.style.height = rect.height + 'px';
		drawDiv.style.backgroundColor = '#000033';
		drawDiv.style.padding = 0;
		regionsDiv.appendChild(drawDiv);

		var drawRect = drawDiv.getBoundingClientRect();

		var scroll = {
			x: document.documentElement.scrollLeft ? document.documentElement.scrollLeft : document.body.scrollLeft,
			y: document.documentElement.scrollTop ? document.documentElement.scrollTop : document.body.scrollTop,
			};

		//console.log('[HdxVideo.js] Visible regions:');
		for (var i = 0; i < regions.length; ++i) {
			//console.log('[HdxVideo.js] ' + hdxMediaStream.rectToString(regions[i]));
			var borderWidth = 2;
			var visRgn = document.createElement('div');
			visRgn.style.position = 'absolute';
			visRgn.style.left = scroll.x + regions[i].left + drawRect.left + 'px';
			visRgn.style.top = scroll.y + regions[i].top + drawRect.top + 'px';
			visRgn.style.width = regions[i].width - borderWidth - borderWidth + 'px';
			visRgn.style.height = regions[i].height - borderWidth - borderWidth + 'px';
			visRgn.style.backgroundColor = '#808080';
			visRgn.style.border = 'solid #ff0000';
			visRgn.style.borderWidth = borderWidth + 'px';
			visRgn.style.opacity = 0.5;

			drawDiv.appendChild(visRgn);
		}
	}
};

hdxMediaStream.selectTopmost = function(elA, elB) {
// returns whichever element is found to be on top. If it cannot be determined, returns undefined
	var rv = undefined;

	var rectA = elA.getBoundingClientRect();
	var rectB = elB.getBoundingClientRect();
	var intersectRect = hdxMediaStream.intersectRects(rectA, rectB);

	// clip rectangles to window rectangle
	intersectRect = hdxMediaStream.clipRect(intersectRect, 0, 0, window.innerWidth, window.innerHeight);

	if (intersectRect)
	{
		var checkRects = [intersectRect];
		while (rv === undefined)
		{
			var rect = checkRects.shift();
			if (!rect)
				break;

			var pt = {
				x: (rect.left + rect.right) / 2,
				y: (rect.top + rect.bottom) / 2
				};

			var pickEl = document.elementFromPoint(pt.x, pt.y);
			if (pickEl == elA || pickEl == elB)
			{
				rv = pickEl;
			}
			else if (pickEl)
			{
				// Some third element.  Clip this element out of the rectangle we're checking, and look at the remaining parts.
				var topElRect = pickEl.getBoundingClientRect();

				if (pt.x >= topElRect.left && pt.x <= topElRect.right && pt.y >= topElRect.top && pt.y <= topElRect.bottom)
				{
					// clip to window rectangle
					var topElRectClipped = hdxMediaStream.clipRect(topElRect, 0, 0, window.innerWidth, window.innerHeight);
					var subtractResult = hdxMediaStream.rectListSubtractRect([rect], topElRectClipped);

					if (subtractResult.intersected == true) {
						checkRects = checkRects.concat(subtractResult.rects);
					} else {
						// adjacent, not intersecting... ignore.
						if (DEBUG_ONLY)
							console.log('[HdxVideo.js] Selected adjacent rectangle?  Shouldn&quot;t happen, ideally.');
					}
				}
				else
				{
					//console.log('[HdxVideo.js] elementFromPoint(' + pt.x + ',' + pt.y +
					//	') unexpectedly returned an element not containing the point, rect: ' +
					//	hdxMediaStream.rectToString(topElRect));
				}
			}
			else
			{
				//console.log('[HdxVideo.js] document.elementFromPoint() returns null.');
			}
		}
	}

	return rv;
};

hdxMediaStream.pollRoutine = function() {

	hdxMediaStream.printVideoPositions();
	hdxMediaStream.onScroll(); //TODO: we should be able to rely on events for this

	var otherElements = document.getElementsByTagName('*');

	for (var key in hdxMediaStream.redirectedVideos)
	{
		var vid = hdxMediaStream.redirectedVideos[key];
		var vidRect = vid.getBoundingClientRect();

		var clipList = [{left: vidRect.left, top: vidRect.top, right: vidRect.right, bottom: vidRect.bottom, width: vidRect.width, height: vidRect.height}];

		for (var j = 0; j < otherElements.length; ++j)
		{
			if (otherElements[j] == vid || otherElements[j].className == 'hdxChroma')
				continue; // skip self

			if (hdxMediaStream.selectTopmost(vid, otherElements[j]) == otherElements[j])
			{
				var otherRect = otherElements[j].getBoundingClientRect();
				//var bgcolor = (document.defaultView.getComputedStyle) ? document.defaultView.getComputedStyle(otherElements[j], "").backgroundColor : "";
				//console.log('[HdxVideo.js] On top: ' + otherElements[j]);
				//console.log('[HdxVideo.js]       : {' + intersectRect.left + ', ' + intersectRect.top + ', ' + intersectRect.right + ', ' + intersectRect.bottom + '}');
				//console.log('[HdxVideo.js]       : ' + otherElements[j].outerHTML);
				//if (bgcolor != 'transparent') // check isn't yet reliable, as a parent object may actually be picked
					clipList = hdxMediaStream.rectListSubtractRect(clipList, otherRect).rects;
			}

			//console.log('[HdxVideo.js] ----------');
		}

		//console.log('[HdxVideo.js] ==========');

		for (var i = 0; i < clipList.length; ++i)
		{
			clipList[i].left -= vidRect.left;
			clipList[i].right -= vidRect.left;
			clipList[i].top -= vidRect.top;
			clipList[i].bottom -= vidRect.top;
		}

		clipList = hdxMediaStream.consolidateRegions(clipList);
		hdxMediaStream.sendRegions(vid, clipList);
		hdxMediaStream.drawRegions(vidRect, clipList);
	}
	//console.log('[HdxVideo.js] ##########');
};

/*function viewport() { // From StackOverflow:
	var e = window, a = 'inner';
	if (!('innerWidth' in window )) {
		a = 'client';
		e = document.documentElement || document.body;
	}
	return { width : e[ a+'Width' ] , height : e[ a+'Height' ] };
}*/

hdxMediaStream.sendClientSize = function() {
	var pixelRatio = hdxMediaStream.getPixelRatio();
	//var w = window.innerWidth;
	//var h = window.innerHeight;
	var w = document.documentElement.clientWidth;
	var h = document.documentElement.clientHeight;
	/*var vp = viewport();
	var w = vp.width;
	var h = vp.height;*/

	w *= pixelRatio;
	h *= pixelRatio;

	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] sendClientSize:  w: ' + w + '  h: ' + h);

	if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
		hdxMediaStream.WSSendObject({
		/**@expose*/ v: 'clisz',
		/**@expose*/ w: w,
		/**@expose*/ h: h
		});
	}
};

hdxMediaStream.addEvent = function(obj, name, func)
{
	if (obj.addEventListener) {
		obj.addEventListener(name, func, false);
	} else {
		obj.attachEvent(name, func);
	}
};

hdxMediaStream.GetObjectPropertyDescriptor = function(obj, name) {
	var desc = undefined;
	while (obj != Object.prototype) {
		desc = Object.getOwnPropertyDescriptor(obj, name);
		if (desc !== undefined)
			break;
		obj = obj.__proto__;
	}
	return desc;
};

function HDXTimeRanges(ranges, duration) {
	this.setup(ranges, duration);
}

HDXTimeRanges.prototype = {
	setup: function(ranges, duration) {
		this.ranges = ranges;
		this.length = this.ranges.length;
		this.duration = duration;
	},
	start: function(idx) {
		return this.ranges[idx].start * this.duration / 100.0; // (should throw a DOMException if out of range)
	},
	end: function(idx) {
		return this.ranges[idx].end * this.duration / 100.0;
	}
};

function EventHandlerHook(vid) {
	this.setup(vid);
}

EventHandlerHook.prototype = {
	setup: function(vid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js Events] EventHandlerHook::setup');
		vid.hdxEventHandlerHook = this;

		this.vid = vid;

		this.listeners = [];
		this.events = [];

		this.origHandlers = {};
		this.origProps = {};
		this.interceptedEvents = []; // events we've intercepted and haven't yet decided what to do with
		this.storingEvents = true;
		this.passthrough = false;
		this.dispatching = false; // TRUE while dispatching a message
	},
	intercept: function(eventname) {
		//console.log('[HdxVideo.js Events] EventHandlerHook::intercept: ' + eventname);
		var eventHandlerName = 'on' + eventname;
		this.origHandlers[eventHandlerName] = this.vid[eventHandlerName];
		this.vid[eventHandlerName] = this.eventInterceptor(eventname).bind(this);
		this.origProps[eventHandlerName] = hdxMediaStream.GetObjectPropertyDescriptor(this.vid, eventHandlerName);
		Object.defineProperty(this.vid, eventHandlerName, {
			get: this.getterInterceptor(eventname).bind(this),
			set: this.setterInterceptor(eventname).bind(this),
			configurable: true
			});
	},
	unintercept: function() {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js Events] EventHandlerHook::unintercept');

		this.storingEvents = false;
		this.passthrough = true;

		for (var i = 0; i < this.interceptedEvents.length; ++i) {
			this.dispatchNamedEvent(this.interceptedEvents[i]);
		}
		this.interceptedEvents = [];
	},
	dispatchNamedEvent: function(eventname) {
		//console.log('[HdxVideo.js Events] EventHandlerHook::dispatchNamedEvent: ' + eventname);
		var evt = document.createEvent('Event');
		evt.initEvent(eventname, true, true);
		this.dispatching = true;
		this.vid.dispatchEvent(evt);
		this.dispatching = false;
	},
	eventInterceptor: function() {
		return function(event) {
			//console.log('[HdxVideo.js Events] EventHandlerHook::eventInterceptor: ' + event.type + ' passthrough: ' + this.passthrough + ' dispatching: ' + this.dispatching);

			if (this.dispatching) {
				if (this.origHandlers['on' + event.type])
					this.origHandlers['on' + event.type].bind(this.vid)();
			} else {
				if (this.storingEvents) {
					this.interceptedEvents.push(event.type);
				}
				if (this.passthrough) {
					this.dispatchNamedEvent(event.type);
				}
			}
		};
	},
	getterInterceptor: function(eventname) {
		return function() {
			return this.origHandlers['on' + eventname];
		};
	},
	setterInterceptor: function(eventname) {
		return function(value) {
			this.origHandlers['on' + eventname] = value;
		};
	},
	discardCapturedEvents: function() {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js Events] EventHandlerHook::discardCapturedEvents');
		this.storingEvents = false;
		this.interceptedEvents = [];
	},
	eventListener: function(event) {
		//console.log('[HdxVideo.js Events] hooked evt: ' + event.type + ' phase: ' + event.eventPhase);

		var evts = this.events[event.type];
		if (evts && evts.length > 0) {
			//console.log('[HdxVideo.js Events] evts.length: ' + evts.length);

			if (event.eventPhase == Event.CAPTURING_PHASE || event.eventPhase == Event.AT_TARGET) {
				var listeners = this.listeners[event.type][0];
				//console.log('[HdxVideo.js Events] Capture listeners: ' +  listeners.length);
				for (var i = 0; i < listeners.length; i++) {
					//console.log('[HdxVideo.js Events] Invoking capture event: ' + event.type);
					listeners[i](event);
				}
			}
			
			if (event.eventPhase == Event.AT_TARGET || event.eventPhase == Event.BUBBLING_PHASE) {
				var listeners = this.listeners[event.type][1];
				//console.log('[HdxVideo.js Events] Bubble listeners: ' +  listeners.length);
				for (var i = 0; i < listeners.length; i++) {
					//console.log('[HdxVideo.js Events] Invoking bubble event: ' + event.type);
					listeners[i](event);
				}
			}

			if (event.eventPhase == Event.AT_TARGET || event.eventPhase == Event.BUBBLING_PHASE) { // <-- should be 1=bubble // OK... I changed it... why did it say 0??
				evts.pop();
			}
		} else {
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js Events] ignoring unexpected event: ' + event.type);
		}
	},
	
	// replacements for hooked event listener routines
	ourAddEventListener: function(type, listener, capture) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js Events] ourAddEventListener: ' + type + ' capture: ' + capture);

		if (!this.listeners[type]) {
			this.listeners[type] = [[]];
		}

		var phase_idx = capture ? 0 : 1;
		if (!this.listeners[type][phase_idx]) {
			this.listeners[type][phase_idx] = [];
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js Events] registering our handler for event: ' + type + ' capture: ' + capture);
			hdxMediaStream.origAddEventListener.apply(this.vid, [type, this.eventListener.bind(this), capture]);
		}

		this.listeners[type][phase_idx].push(listener);
	},
	ourRemoveEventListener: function(type, listener, capture) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js Events] ourRemoveEventListener: ' + type + ' capture: ' + capture);

		if (this.listeners[type]) {
			var phase_idx = capture ? 0 : 1;
			var listeners = this.listeners[type][phase_idx];
			if (listeners) {
				var lid = listeners.indexOf(listener);
				if (lid > -1) {
					listeners.splice(lid, 1);
				}
			}
		}
	},
	ourDispatchEvent: function (event) {
		//console.log('[HdxVideo.js Events] ourDispatchEvent: ' + event);

		if (!this.events[event.type]) {
			this.events[event.type] = [];
		}
		this.events[event.type].push(event);

		hdxMediaStream.origDispatchEvent.apply(this.vid, arguments);
	}
};

hdxMediaStream.interceptEventListeners = function() {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js Events] interceptEventListeners()');

	hdxMediaStream.origAddEventListener = hdxMediaStream.origAddEventListener || HTMLMediaElement.prototype['addEventListener'];
	HTMLMediaElement.prototype['addEventListener'] = function(type, listener, useCapture) {
		//console.log('[HdxVideo.js Events] Replacement addEventListener: ' + type);
		if (!this.hdxEventHandlerHook) {
			hdxMediaStream.interceptEvents(this);
		}
		this.hdxEventHandlerHook.ourAddEventListener(type, listener, useCapture);
	};

	hdxMediaStream.origRemoveEventListener = hdxMediaStream.origRemoveEventListener || HTMLMediaElement.prototype['removeEventListener'];
	HTMLMediaElement.prototype['removeEventListener'] = function(type, listener, useCapture) {
		//console.log('[HdxVideo.js Events] Replacement removeEventListener: ' + type);
		if (!this.hdxEventHandlerHook) {
			hdxMediaStream.interceptEvents(this);
		}
		this.hdxEventHandlerHook.ourRemoveEventListener(type, listener, useCapture);
	};

	hdxMediaStream.origDispatchEvent = hdxMediaStream.origDispatchEvent || HTMLMediaElement.prototype['dispatchEvent'];
	HTMLMediaElement.prototype['dispatchEvent'] = function(event) {
		//console.log('[HdxVideo.js Events] Replacement dispatchEvent: ' + event.type);
		if (!this.hdxEventHandlerHook) {
			hdxMediaStream.interceptEvents(this);
		}
		this.hdxEventHandlerHook.ourDispatchEvent(event);
	};
};

hdxMediaStream.interceptEvents = function(vid) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js Events] interceptEvents()');
	if (!vid.hdxEventHandlerHook) {
		var hook = new EventHandlerHook(vid);
		hook.intercept('loadstart');
		hook.intercept('progress');
		hook.intercept('suspend');
		hook.intercept('abort');
		hook.intercept('error');
		hook.intercept('emptied');
		hook.intercept('stalled');
		hook.intercept('loadedmetadata');
		hook.intercept('loadeddata');
		hook.intercept('canplay');
		hook.intercept('canplaythrough');
		hook.intercept('playing');
		hook.intercept('waiting');
		hook.intercept('seeking');
		hook.intercept('seeked');
		hook.intercept('ended');
		hook.intercept('durationchange');
		hook.intercept('timeupdate');
		hook.intercept('play');
		hook.intercept('pause');
		hook.intercept('ratechange');
		hook.intercept('volumechange');
	}
};

hdxMediaStream.findVideoElements = function() {
	var videos = document.getElementsByTagName('video');
	for (var i = 0; i < videos.length; i++)
	{
		if (hdxMediaStream.foundVideos.indexOf(videos[i]) == -1) {
			hdxMediaStream.foundVideos.push(videos[i]);
			hdxMediaStream.pendingVideos.push(videos[i]);
			hdxMediaStream.interceptEvents(videos[i]);
		}
		//else
		//	console.log('[HdxVideo.js] Video already in array.');
	}

	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] Unredirected video count: ' + hdxMediaStream.pendingVideos.length);
	if (hdxMediaStream.pendingVideos.length)
		hdxMediaStream.doRedirection();
};

hdxMediaStream.exitFullscreen = function () {
	/* Tell all of our video windows to exit full screen.  They know their 
	   fullscreen state so this will have no effect on those windows not in fullscreen. */
	var videos = document.getElementsByTagName('video');
	for (var i = 0; i < videos.length; i++) {
		if (hdxMediaStream.foundVideos.indexOf(videos[i]) != -1) {
			if (videos[i].exitFullscreen) {
				videos[i].exitFullscreen();
			}
		}
	}

	/* Call the standard full screen function, in case there is some other element that is full screen. */
	if (this.origExitFullscreen) {
		console.log('[HdxVideo.js] exitFullscreen - Found!');
		this.origExitFullscreen();
	}
	else if (this.origMsExitFullscreen) {
		console.log('[HdxVideo.js] msexitFullscreen - Found!');
		this.origMsExitFullscreen();
	}
	else if (this.origMozCancelFullscreen) {
		console.log('[HdxVideo.js] mozCancelFullScreen - Found!');
		this.origMozCancelFullscreen();
	}
	else if (this.origWebkitExitFullscreen) {
		console.log('[HdxVideo.js] webkitexitFullscreen - Found!');
		this.origWebkitExitFullscreen();
	}
	else {
		console.log('[HdxVideo.js] !! No fullscreen method found !!');
	}
};

hdxMediaStream.onScroll = function(uiEvent) {
	//console.log('[HdxVideo.js] onScroll:');
	hdxMediaStream.printVideoPositions();

	hdxMediaStream.onOriginChanged();
	hdxMediaStream.onRegionChanged();
};

hdxMediaStream.onResize = function(uiEvent) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] onResize:');
	hdxMediaStream.printVideoPositions();

	//hdxMediaStream.onOriginChanged(); // probably don't need this?
	hdxMediaStream.onRegionChanged(); // definitely need this, though.

	hdxMediaStream.sendClientSize();
};

hdxMediaStream.onVisibilityChange = function(event) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] onVisibilityChange:');

	if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
		hdxMediaStream.WSSendObject({
			/**@expose*/ v: 'vis',
			/**@expose*/ vis: (!document.hidden)
		});
	}
};

hdxMediaStream.getOrigin = function() {
	var rv = undefined;

	if (hdxMediaStream.origin) {
		rv = hdxMediaStream.origin;
	} else {
		if ((!window.parent) || (window == window.parent)) {
			hdxMediaStream.origin = {left: 0, top: 0};
			rv = hdxMediaStream.origin;
		} else {
			window.parent.postMessage({msgtype: 'getOrigin', parameter: false}, '*');
		}
	}

	return rv;
};

hdxMediaStream.sendGlobalClientScreenOffset = function(cso) {
	var ldelta = 0;
	var tdelta = 0;

	if (hdxMediaStream.clientScreenOffset) {
		ldelta = (hdxMediaStream.clientScreenOffset.left > cso.left) ?
			hdxMediaStream.clientScreenOffset.left - cso.left :
			cso.left - hdxMediaStream.clientScreenOffset.left;

		tdelta = (hdxMediaStream.clientScreenOffset.top > cso.top) ?
			hdxMediaStream.clientScreenOffset.top - cso.top :
			cso.top - hdxMediaStream.clientScreenOffset.top;
	}

	if ((!hdxMediaStream.clientScreenOffset) ||
		ldelta > 0.50 || tdelta > 0.50) // Because of scaling, offset changes within a small margin will be ignored
	{
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) {
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] clientScreenOffset: {' +
					cso.left + ', ' + cso.top + '}');

			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'cso',
				/**@expose*/ x: cso.left,
				/**@expose*/ y: cso.top
			});
			hdxMediaStream.clientScreenOffset = cso;
		}

		// blast this notification down to everyone else
		if (hdxMediaStream.boundingRectListeners)
			for (var i = 0; i < hdxMediaStream.boundingRectListeners.length; ++i)
				hdxMediaStream.boundingRectListeners[i].postMessage({msgtype: 'setClientScreenOffset', parameter: cso}, '*');
	}
};

hdxMediaStream.sendLocalClientScreenOffset = function(local_cso) {
	var ldelta = 0;
	var tdelta = 0;

	if (hdxMediaStream.localClientScreenOffset) {
		ldelta = (hdxMediaStream.localClientScreenOffset.left > local_cso.left) ?
			hdxMediaStream.localClientScreenOffset.left - local_cso.left :
			local_cso.left - hdxMediaStream.localClientScreenOffset.left;

		tdelta = (hdxMediaStream.localClientScreenOffset.top > local_cso.top) ?
			hdxMediaStream.localClientScreenOffset.top - local_cso.top :
			local_cso.top - hdxMediaStream.localClientScreenOffset.top;
	}

	if ((!hdxMediaStream.clientScreenOffset) ||
		ldelta > 0.50 || tdelta > 0.50) // Because of scaling, offset changes within a small margin will be ignored
	{
		if ((hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1)) ||
			(hdxMediaStream.boundingRectListeners && hdxMediaStream.boundingRectListeners.length > 0)) {
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] localClientScreenOffset: {' +
					local_cso.left + ', ' + local_cso.top + '}');
		}
		hdxMediaStream.localClientScreenOffset = local_cso;

		if ((!window.parent) || (window == window.parent)) {
			// we're already the top window.
			hdxMediaStream.sendGlobalClientScreenOffset(hdxMediaStream.localClientScreenOffset);
		} else {
			// ask our parent for the value
			window.parent.postMessage({msgtype: 'getClientScreenOffset', parameter: local_cso}, '*');
		}
	}
};

hdxMediaStream.getPixelRatio = function() {
	if (hdxMediaStream.lastPixelRatio != window.devicePixelRatio) {
		hdxMediaStream.lastPixelRatio = window.devicePixelRatio;
		// ratio has changed -- let everyone know...
		hdxMediaStream.onOriginChanged();
	}
	return window.devicePixelRatio;
};

hdxMediaStream.insetRect = function(rect, l, t, r, b) {
	return { left: rect.left + l,
		top: rect.top + t,
		width: rect.width - (l + r),
		height: rect.height - (t + b),
		right: rect.right ? rect.right - (l + r) : rect.left + rect.width - (l + r),
		bottom: rect.bottom ? rect.bottom - (t + b) : rect.top + rect.height - (t + b)};
};

hdxMediaStream.clipRect = function(rect, l, t, r, b) {
	if (!rect)
		return null;

	var rv = {
		left: Math.max(rect.left, l),
		right: Math.min(rect.right, r),
		top: Math.max(rect.top, t),
		bottom: Math.min(rect.bottom, b)
		};
	rv.width = rv.right - rv.left;
	rv.height = rv.bottom - rv.top;
	return (rv.width > 0 && rv.height > 0) ? rv : null;
};

hdxMediaStream.scaleRect = function(rect, pixelRatio) {
	return { left: rect.left * pixelRatio,
		top: rect.top * pixelRatio,
		width: rect.width * pixelRatio,
		height: rect.height * pixelRatio,
		right: (rect.right ? rect.right : (rect.left + rect.width)) * pixelRatio,
		bottom: (rect.bottom ? rect.bottom : (rect.top + rect.height)) * pixelRatio};
};

hdxMediaStream.getFrameInsideRect = function(frame) {
	var pixelRatio = hdxMediaStream.getPixelRatio();

	return hdxMediaStream.insetRect(hdxMediaStream.scaleRect(frame.getBoundingClientRect(), pixelRatio),
		parseInt(getComputedStyle(frame, null).getPropertyValue('border-left-width'), 10) * pixelRatio,
		parseInt(getComputedStyle(frame, null).getPropertyValue('border-top-width'), 10) * pixelRatio,
		parseInt(getComputedStyle(frame, null).getPropertyValue('border-right-width'), 10) * pixelRatio,
		parseInt(getComputedStyle(frame, null).getPropertyValue('border-bottom-width'), 10) * pixelRatio
	);
};

hdxMediaStream.intersectRgn = function(rgn1, rgn2) {
	var rv = {};

	rv.left = Math.max(rgn1.left, rgn2.left);
	//var i_right = ((rgn1.left + rgn1.width) < (rgn2.left + rgn2.width)) ? (rgn1.left + rgn1.width) : (rgn2.left + rgn2.width);
	//rv.width = i_right - rv.left;
	rv.right = Math.min(rgn1.right, rgn2.right);
	rv.top = Math.max(rgn1.top, rgn2.top);
	//var i_bottom = ((rgn1.top + rgn1.height) < (rgn2.top + rgn2.height)) ? (rgn1.top + rgn1.height) : (rgn2.top + rgn2.height);
	//rv.height = i_bottom - rv.top;
	rv.bottom = Math.min(rgn1.bottom, rgn2.bottom);

	return rv;
};

hdxMediaStream.translateRgn = function(rgn, translateX, translateY) {
	var rv = rgn;

	rv.left += translateX;
	rv.top += translateY;
	rv.right += translateX;
	rv.bottom += translateY;

	return rv;
};

hdxMediaStream.createRgnForBoundingRect = function(rect) {
	var pixelRatio = hdxMediaStream.getPixelRatio();
	var rgn = hdxMediaStream.region ? hdxMediaStream.region : {
		left: 0, top: 0,
		right: document.documentElement.clientWidth * pixelRatio,
		bottom: document.documentElement.clientHeight * pixelRatio};

	rgn = hdxMediaStream.intersectRgn(rgn, rect);
	rgn = hdxMediaStream.translateRgn(rgn, -rect.left, -rect.top);

	return rgn;
};

hdxMediaStream.onOriginChanged = function() {
	if (hdxMediaStream.boundingRectListeners) {
		var frameElements = document.getElementsByTagName('iframe');
		for (var i = 0; i < frameElements.length; ++i) {
			if (hdxMediaStream.boundingRectListeners.indexOf(frameElements[i].contentWindow) != -1) {
				var r = hdxMediaStream.getFrameInsideRect(frameElements[i]);
				if (hdxMediaStream.origin)
					frameElements[i].contentWindow.postMessage({msgtype: 'setOrigin', parameter: {left: hdxMediaStream.origin.left + r.left, top: hdxMediaStream.origin.top + r.top}}, '*');
			}
		}
	}
};

hdxMediaStream.onRegionChanged = function() {
	if (hdxMediaStream.boundingRectListeners) {
		var frameElements = document.getElementsByTagName('iframe');
		for (var i = 0; i < frameElements.length; ++i) {
			if (hdxMediaStream.boundingRectListeners.indexOf(frameElements[i].contentWindow) != -1) {
				var r = hdxMediaStream.getFrameInsideRect(frameElements[i]);
				frameElements[i].contentWindow.postMessage({msgtype: 'visibleRegion', parameter: hdxMediaStream.createRgnForBoundingRect(r)}, '*');
			}
		}
	}
};

hdxMediaStream.onMouseMove = function(mouseEvent) {
	/*console.log('[HdxVideo.js] onMouseMove:' +
		'  page: ' + mouseEvent.pageX + ', ' + mouseEvent.pageY +
		'  client: ' + mouseEvent.clientX + ', ' + mouseEvent.clientY +
		'  screen: ' + mouseEvent.screenX + ', ' + mouseEvent.screenY);*/

	if (mouseEvent.screenX != 0 && mouseEvent.screenY != 0) { // sometimes, Chrome sends 0,0 as screen coordinates!
		var pixelRatio = hdxMediaStream.getPixelRatio();

		hdxMediaStream.sendLocalClientScreenOffset({ left: mouseEvent.screenX - (mouseEvent.clientX * pixelRatio),
				top: mouseEvent.screenY - (mouseEvent.clientY * pixelRatio) });
	}
};

hdxMediaStream.installMyEventListeners = function() {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] Installing event listeners.');
	hdxMediaStream.addEvent(window, 'resize', hdxMediaStream.onResize);
	hdxMediaStream.addEvent(document, 'visibilitychange', hdxMediaStream.onVisibilityChange);
	//TODO: What do we want besides mousemove?
	hdxMediaStream.addEvent(document, 'mousemove', hdxMediaStream.onMouseMove);

	try {
		if (document.exitFullscreen) {
			console.log('[HdxVideo.js] exitFullscreen - Found!');
			this.origExitFullscreen = document.exitFullscreen.bind(document);
			document.exitFullscreen = this.exitFullscreen.bind(this);
		}
		else if (document.msExitFullscreen) {
			console.log('[HdxVideo.js] msexitFullscreen - Found!');
			this.origMsExitFullscreen = document.msExitFullscreen.bind(document);
			document.msExitFullscreen = this.exitFullscreen.bind(this);
		}
		else if (document.mozCancelFullScreen) {
			console.log('[HdxVideo.js] mozCancelFullScreen - Found!');
			this.origMozCancelFullscreen = document.mozCancelFullScreen.bind(document);
			document.mozCancelFullScreen = this.exitFullscreen.bind(this);
		}
		else if (document.webkitExitFullscreen) {
			console.log('[HdxVideo.js] webkitexitFullscreen - Found!');
			this.origWebkitExitFullscreen = document.webkitExitFullscreen.bind(document);
			document.webkitExitFullscreen = this.exitFullscreen.bind(this);
		}
		else {
			console.log('[HdxVideo.js] !! No fullscreen method found !!');
		}
	}
	catch (err)
	{
		console.log('Caught Exception %s', err);
	}

};

hdxMediaStream.getVideoClientRect = function(vid) {
// computes the rectangle of the scaled video within the video element, excluding any added padding to correct for aspect ratio.
	var rect = hdxMediaStream.insetRect(vid.getBoundingClientRect(), 0, 0, 0, 0); // makes rect mutable
	if (vid.width && vid.height)
	{
		if (vid.width > rect.width)
		{
			var scale = rect.width / vid.width;
			var dif_y = vid.height - (vid.height * scale);
			rect.top += (dif_y / 2);
			rect.height -= dif_y;
			rect.bottom = rect.top + rect.height;
		}
		else if (rect.width > vid.width)
		{
			var dif_x = rect.width - vid.width;
			rect.width = vid.width;
			rect.left += (dif_x / 2);
			rect.right = rect.left + rect.width;
		}

	}
	//console.log('[HdxVideo.js] {l:' + rect.left + ' t:' + rect.top + ' r:' + rect.right + ' b:' + rect.bottom + ' w:' + rect.width + ' h:' + rect.height + '}');

	return rect;
};

function HdxVideo(target, videoid) { // Javascript class creator function for HdxVideo
	this.setup(target, videoid);
}

HdxVideo.prototype = {
	setup: function(target, videoid) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Setting up video swap-in...');
		//this.name = 'Hdx video swap-in';
		this.target = target;
		this.videoid = videoid;
		this.hooks_applied = false;
		this.paused = true;
		this.reqstate = ''; // last requested and as-of-yet unacknowledged state
		this.playing = false;
		this.ended = false;
		this.seeking = false; // TODO: send seeking events when appropriate
		this.error = null;
		this.currentSrc = '';
		this.reportedPosition = 0.0;
		this.reportedPositionTime = new Date();
		this.timer = null;
		this.reportedBufferedRanges = [];
		this.duration = 0.0;
		this.autoplay = target.autoplay;
		if (!target.paused)
			target.pause();
		this.hasPlayedOnce = false;
		this.loop = false;
		this.controls = this.target.controls;

		this.volume = 1.0;
		this.muted = false;

		this.lastPos = {left: 0, top: 0, right: 0, bottom: 0, width: 0, height: 0};

		this.videoWidth = undefined;
		this.videoHeight = undefined;
		this.attrWidth = this.target.hasAttribute('width') ? this.target.getAttribute('width') : undefined;
		this.attrHeight = this.target.hasAttribute('height') ? this.target.getAttribute('height') : undefined;
		this.computedWidth = 0;
		this.computedHeight = 0;

		this.target.hdxvid = this;
		this.origProps = {};

		this.hook();
	},
	hook: function() {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Applying video hooks...');

		if (!this.hooks_applied) {
			this.origSrc = this.target.src;
			this.origCurrentSrc = this.target.currentSrc;
			this.duration = this.target.duration;

			this.visible = true;                          // Originally, had some default visibility...
			this.origVisibility = this.target.visibility; // and we'll save that...
			this.makeVisible(false);                      // but we will hide it, to prevent user seeing error messages

			this.target.src = '';

			this.origLoad = this.target.load.bind(this.target);
			this.target.load = this.load.bind(this);
			
			this.origCanPlayType = this.target.canPlayType.bind(this.target);
			this.target.canPlayType = this.canPlayType.bind(this);

			this.origPlay = this.target.play.bind(this.target);
			this.target.play = this.play.bind(this);

			this.origPause = this.target.pause.bind(this.target);
			this.target.pause = this.pause.bind(this);

			if (this.target.requestFullscreen) {
				console.log('[HdxVideo.js] requestFullscreen - Found!');
				this.origRequestFullscreen = this.target.requestFullscreen.bind(this.target);
				this.target.requestFullscreen = this.setFullscreen.bind(this);
			}
			else if (document.documentElement.msRequestFullscreen) {
				console.log('[HdxVideo.js] msRequestFullscreen - Found!');
				this.origMsRequestFullscreen = this.target.msRequestFullscreen.bind(this.target);
				this.target.msRequestFullscreen = this.setFullscreen.bind(this);
			}
			else if (document.documentElement.mozRequestFullScreen) {
				console.log('[HdxVideo.js] mozRequestFullScreen - Found!');
				this.origMozRequestFullscreen = this.target.mozRequestFullScreen.bind(this.target);
				this.target.mozRequestFullScreen = this.setFullscreen.bind(this);
			}
			else if (document.documentElement.webkitRequestFullscreen) {
				console.log('[HdxVideo.js] webkitRequestFullscreen - Found!');
				this.origWebkitRequestFullscreen = this.target.webkitRequestFullscreen.bind(this.target);
				this.target.webkitRequestFullscreen = this.setFullscreen.bind(this);
			}
			else {
				console.log('[HdxVideo.js] !! No fullscreen method found !!');
			}

			this.target.exitFullscreen = this.exitFullscreen.bind(this);

			try { // This will not work if the 'paused' property is not 'configurable'... may be a problem.

				this.origProps.error = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'error');
				Object.defineProperty(this.target, 'error', {
					get: this.getError.bind(this),
					set: this.setError.bind(this),
					configurable: true
					});

				this.origProps.src = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'src');
				Object.defineProperty(this.target, 'src', {
					get: this.getSrc.bind(this),
					set: this.setSrc.bind(this),
					configurable: true
					});

				this.origProps.currentSrc = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'currentSrc');
				Object.defineProperty(this.target, 'currentSrc', {
					get: this.getCurrentSrc.bind(this),
					configurable: true
					});
				
				// crossOrigin
				
				// networkState
				
				// preload
				
				this.origProps.buffered = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'buffered');
				Object.defineProperty(this.target, 'buffered', {
					get: this.getBuffered.bind(this),
					configurable: true
					});
				
				// readyState
				
				this.origProps.seeking = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'seeking');
				Object.defineProperty(this.target, 'seeking', {
					get: this.getSeeking.bind(this),
					configurable: true
					});

				this.origProps.currentTime = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'currentTime');
				Object.defineProperty(this.target, 'currentTime', {
					get: this.getCurrentTime.bind(this),
					set: this.setCurrentTime.bind(this),
					configurable: true
					});

				this.origProps.duration = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'duration');
				Object.defineProperty(this.target, 'duration', {
					get: this.getDuration.bind(this),
					configurable: true
					});

				this.origProps.paused = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'paused');
				Object.defineProperty(this.target, 'paused', {
					get: this.isPaused.bind(this),
					configurable: true
					});

				// defaultPlaybackRate

				// playbackRate

				// played

				// seekable

				this.origProps.ended = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'ended');
				Object.defineProperty(this.target, 'ended', {
					get: this.getEnded.bind(this),
					configurable: true
					});

				this.origProps.autoplay = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'autoplay');
				Object.defineProperty(this.target, 'autoplay', {
					get: this.getAutoplay.bind(this),
					set: this.setAutoplay.bind(this),
					configurable: true
					});

				// loop - handled by target video element

				// mediaGroup
				
				// controller

				this.origProps.controls = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'controls');
				Object.defineProperty(this.target, 'controls', {
					get: this.getControls.bind(this),
					set: this.setControls.bind(this),
					configurable: true
					});

				this.origProps.volume = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'volume');
				Object.defineProperty(this.target, 'volume', {
					get: this.getVolume.bind(this),
					set: this.setVolume.bind(this),
					configurable: true
					});

				this.origProps.muted = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'muted');
				Object.defineProperty(this.target, 'muted', {
					get: this.getMuted.bind(this),
					set: this.setMuted.bind(this),
					configurable: true
					});

				// defaultMuted
				
				// audioTracks

				// videoTracks

				// textTracks


				//// HTMLVideoElement attributes //// //TODO: only implement these if not audio?

				this.origProps.width = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'width');
				Object.defineProperty(this.target, 'width', {
					get: this.getWidth.bind(this),
					set: this.setWidth.bind(this),
					configurable: true
					});

				this.origProps.height = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'height');
				Object.defineProperty(this.target, 'height', {
					get: this.getHeight.bind(this),
					set: this.setHeight.bind(this),
					configurable: true
					});

				this.origProps.videoWidth = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'videoWidth');
				Object.defineProperty(this.target, 'videoWidth', {
					get: this.getVideoWidth.bind(this),
					configurable: true
					});

				this.origProps.videoHeight = hdxMediaStream.GetObjectPropertyDescriptor(this.target, 'videoHeight');
				Object.defineProperty(this.target, 'videoHeight', {
					get: this.getVideoHeight.bind(this),
					configurable: true
					});

				// poster


				this.origAppendChild = this.origAppendChild || this.target.appendChild.bind(this.target);
				this.target.appendChild = this.appendChild.bind(this);

			} catch (exc) {
				console.log('[HdxVideo.js] hooks() Exception: ' + exc.message);
			}

			this.hooks_applied = true;
		}
	},
	unhook: function (svrender) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Removing video hooks...');

		if (this.target.hdxEventHandlerHook)
			this.target.hdxEventHandlerHook.unintercept();

		if (this.hooks_applied)
		{
			this.target.load = this.origLoad;
			this.target.canPlayType = this.origCanPlayType;
			this.target.play = this.origPlay;
			this.target.pause = this.origPause;

			if (this.origRequestFullscreen)
				this.target.requestFullscreen = this.origRequestFullscreen;

			if (this.origMsRequestFullscreen)
				this.target.msRequestFullscreen = this.origMsRequestFullscreen;

			if (this.origMozRequestFullscreen)
				this.target.mozRequestFullScreen = this.origMozRequestFullscreen;

			if (this.origWebkitRequestFullscreen)
				this.target.webkitRequestFullscreen = this.origWebkitRequestFullscreen;

			if (this.origProps.error)
				Object.defineProperty(this.target, 'error', this.origProps.error);

			if (this.origProps.src)
				Object.defineProperty(this.target, 'src', this.origProps.src);

			if (this.origProps.currentSrc)
				Object.defineProperty(this.target, 'currentSrc', this.origProps.currentSrc);

			// crossOrigin
			
			// networkState
			
			// preload
			
			if (this.origProps.buffered)
				Object.defineProperty(this.target, 'buffered', this.origProps.buffered);
			
			// readyState
			
			if (this.origProps.seeking)
				Object.defineProperty(this.target, 'seeking', this.origProps.seeking);

			if (this.origProps.currentTime)
				Object.defineProperty(this.target, 'currentTime', this.origProps.currentTime);

			// duration

			if (this.origProps.paused)
				Object.defineProperty(this.target, 'paused', this.origProps.paused);

			// defaultPlaybackRate

			// playbackRate

			// played

			// seekable

			if (this.origProps.ended)
				Object.defineProperty(this.target, 'ended', this.origProps.ended);

			if (this.origProps.autoplay)
				Object.defineProperty(this.target, 'autoplay', this.origProps.autoplay);

			// loop - handled by target video element

			// mediaGroup
			
			// controller

			if (this.origProps.controls)
				Object.defineProperty(this.target, 'controls', this.origProps.controls);

			if (this.origProps.volume)
				Object.defineProperty(this.target, 'volume', this.origProps.volume);

			if (this.origProps.muted)
				Object.defineProperty(this.target, 'muted', this.origProps.muted);

			// defaultMuted
			
			// audioTracks

			// videoTracks

			// textTracks

			//// HTMLVideoElement attributes ////

			if (this.origProps.width)
				Object.defineProperty(this.target, 'width', this.origProps.width);

			if (this.origProps.height)
				Object.defineProperty(this.target, 'height', this.origProps.height);

			if (this.origProps.videoWidth)
				Object.defineProperty(this.target, 'videoWidth', this.origProps.videoWidth);

			if (this.origProps.videoHeight)
				Object.defineProperty(this.target, 'videoHeight', this.origProps.videoHeight);

			// poster


			//perform browser based server rendering
			if (svrender) {
				if (this.origSrc)
					this.target.src = this.origSrc;
				else if (this.origCurrentSrc)
					this.target.src = this.origCurrentSrc;
			}

			this.makeVisible(true); // restore visibility

			this.target.appendChild = this.origAppendChild;

			this.hooks_applied = false;
		}

	},
	load: function() { // initiates the loading of the media file specified by the src attributes.
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Loading media...');
	},
	canPlayType: function(type) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] original canPlayType(' + type + ') returns: ' + this.origCanPlayType(type));
		var rv;
		if (type.toLowerCase().indexOf('mp4') !== -1)
			rv = (type.toLowerCase().indexOf('codec') === -1) ? 'maybe' : 'probably';
		else
			rv = '';

		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] canPlayType(' + type + ') returns: ' + rv);
		return rv;
	},
	play: function() { // initiates playback of the loaded media file.
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Initiating playback...');

		if (this.paused) {
			this.paused = false;
			this.reqstate = 'play';
			// 'this.playing' doesn't change state until the server says so!
			this.ended = false;
			if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
				hdxMediaStream.WSSendObject({
					/**@expose*/ v: 'play',
					/**@expose*/ id: this.videoid
				});
			this.hasPlayedOnce = true;
			this.resyncTimer();
			hdxMediaStream.sendEvent(this.target, 'play');
		} else {
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] Already playing...');
		}
	},
	pause: function() {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Pausing playback...');

		if (!this.paused) {
			this.paused = true;
			this.reqstate = 'pause';
			this.playing = false;
			if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
				hdxMediaStream.WSSendObject({
					/**@expose*/ v: 'pause',
					/**@expose*/ id: this.videoid
				});
			this.resyncTimer();
			hdxMediaStream.sendEvent(this.target, 'pause');
		} else {
			if (DEBUG_ONLY)
				console.log('[HdxVideo.js] Already paused...');
		}
	},
	onTimer: function() {
		hdxMediaStream.sendEvent(this.target, 'timeupdate');
	},
	resyncTimer: function() {
		if (this.timer)
			clearInterval(this.timer);
		this.timer = this.playing ? setInterval(this.onTimer.bind(this), 1000) : null;
	},
	makeVisible: function(visible) {
		if (visible) {
			if (!this.visible) {
				if (DEBUG_ONLY)
					console.log('[HdxVideo.js] Restoring visibility.');
				this.target.style.visibility = this.origVisibility ? this.origVisibility : 'visible';
				hdxMediaStream.pollRoutine();
			}
		} else {
			this.target.style.visibility = 'hidden';
		}
		this.visible = visible;
	},
	isPaused: function() {
		return this.paused;
	},
	getError: function() {
		return this.error;
	},
	setError: function(error) {
		this.error = {code: error};
	},
	getSrc: function() {
		return this.origSrc;
	},
	setSrc: function(src) {
		console.log('[HdxVideo.js] Setting src: \'' + src + '\' : NOT YET IMPLEMENTED');
		this.origSrc = src;
		//TODO: presumably, send the new src to the server, followed by a "srcset" message, to indicate we've sent a new list of (one) sources.
		//TODO: what if this is a relative path??
	},
	getCurrentSrc: function() {
		return this.currentSrc;
	},
	getBuffered: function() {
		return new HDXTimeRanges(this.reportedBufferedRanges, this.duration);
	},
	getSeeking: function() {
		return this.seeking;
	},
	getCurrentTime: function() {
		var computed = this.reportedPosition + 
			(this.playing ? (new Date() - this.reportedPositionTime) / 1000.0 : 0);
		if (computed > this.duration)
			computed = this.duration;
		return computed;
	},
	setCurrentTime: function(currentTime) {
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'time',
				/**@expose*/ id: this.videoid,
				/**@expose*/ time: parseFloat(currentTime)
			});
	},
	getDuration: function() {
		return this.duration;
	},
	getAutoplay: function() {
		return this.autoplay;
	},
	setAutoplay: function(autoplay) {
		this.autoplay = autoplay;
		if (this.autoplay && !this.hasPlayedOnce)
			this.target.play();
	},
	getEnded: function() {
		return this.ended;
	},
	setControls: function(controls) {
		this.controls = controls;
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'controls',
				/**@expose*/ id: this.videoid,
				/**@expose*/ controls: !!(controls)
			});
	},
	getControls: function() {
		return this.controls;
	},
	getVolume: function() {
		return this.volume;
	},
	setVolume: function(volume) {
		this.volume = volume;
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'vol',
				/**@expose*/ id: this.videoid,
				/**@expose*/ vol: parseFloat(this.volume)
			});
	},
	getMuted: function() {
		return this.muted;
	},
	setMuted: function(muted) {
		this.muted = muted;
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'mute',
				/**@expose*/ id: this.videoid,
				/**@expose*/ mute: !!(this.muted)
			});
	},
	getWidth: function() {
		return this.attrWidth;
	},
	setWidth: function(width) {
		this.attrWidth = width;
		hdxMediaStream.recomputeSize(this);
	},
	getHeight: function() {
		return this.attrHeight;
	},
	setHeight: function(height) {
		this.attrHeight = height;
		hdxMediaStream.recomputeSize(this);
	},
	getVideoWidth: function() {
		return this.videoWidth;
	},
	getVideoHeight: function() {
		return this.videoHeight;
	},
	setFullscreen: function() {
		console.log('[HdxVideo.js] fullscreen requested.');
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'fullscreen',
				/**@expose*/ id: this.videoid,
				/**@expose*/ fullscreen: true
			});
	},
	exitFullscreen: function() {
		console.log('[HdxVideo.js] exit from fullscreen requested.');
		if (hdxMediaStream.websocket && (hdxMediaStream.websocket.readyState == 1))
			hdxMediaStream.WSSendObject({
				/**@expose*/ v: 'fullscreen',
				/**@expose*/ id: this.videoid,
				/**@expose*/ fullscreen: false
			});
	},
	appendChild: function(element) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Appending child element...');
	}
};

hdxMediaStream.doRedirection = function() {
	hdxMediaStream.installMyEventListeners();

	if (!hdxMediaStream.websocket || hdxMediaStream.websocket.readyState != 1)
	{
		hdxMediaStream.websocket = new WebSocket('wss://127.0.0.1:9001');
		hdxMediaStream.websocket.onmessage = hdxMediaStream.onWSMessage;
		hdxMediaStream.websocket.onopen = hdxMediaStream.onWSOpen;
		hdxMediaStream.websocket.onclose = hdxMediaStream.onWSClose;
		hdxMediaStream.websocket.onerror = hdxMediaStream.onWSError;
	} else {
		hdxMediaStream.onWSOpen();
	}
};

if (window.addEventListener) { // if required level of functionality not present in browser, don't do things that could break the JS

if (DEBUG_ONLY) {
document.addEventListener('click', function(mouseEvent) {
	// Mouse events provide coordinates in page, client, and screen offsets.
	console.log('[HdxVideo.js] onClick: ' +
		'page: ' + mouseEvent.pageX + ',' + mouseEvent.pageY,
		'client: ' + mouseEvent.clientX + ',' + mouseEvent.clientY,
		'screen: ' + mouseEvent.screenX + ',' + mouseEvent.screenY);
	//hdxMediaStream.printVideoPositions();
	//hdxMediaStream.printVideoPositions();
}, false);
}

document.addEventListener('DOMNodeInserted', function(mutationEvent) {
	//console.log('[HdxVideo.js] OnDOMNodeInserted: ' + mutationEvent.target.tagName);
	var videoElements = (mutationEvent.target.getElementsByTagName) ? mutationEvent.target.getElementsByTagName('VIDEO') : [];
	if (mutationEvent.target.tagName == 'VIDEO' || videoElements.length) {
		if (DEBUG_ONLY)
			console.log('[HdxVideo.js] Adding video.');
		hdxMediaStream.findVideoElements();
	}
}, false);

if (DEBUG_ONLY) {
document.addEventListener('DOMNodeInsertedIntoDocument', function(mutationEvent) {
	console.log('[HdxVideo.js] OnDOMNodeInsertedIntoDocument');
}, false);
}

window.addEventListener('load', function(uiEvent) {
	if (DEBUG_ONLY)
		console.log('[HdxVideo.js] OnLoad (window): ' + uiEvent.target);
	hdxMediaStream.findVideoElements();
}, false);

hdxMediaStream.addEvent(window, 'scroll', hdxMediaStream.onScroll);
hdxMediaStream.interceptEventListeners();

setInterval(hdxMediaStream.pollRoutine, 200); // poll

}
