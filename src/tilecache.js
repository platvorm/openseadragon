/*
 * OpenSeadragon - TileCache
 *
 * Copyright (C) 2009 CodePlex Foundation
 * Copyright (C) 2010-2024 OpenSeadragon contributors
 *
 * Redistribution and use in source and binary forms, with or without
 * modification, are permitted provided that the following conditions are
 * met:
 *
 * - Redistributions of source code must retain the above copyright notice,
 *   this list of conditions and the following disclaimer.
 *
 * - Redistributions in binary form must reproduce the above copyright
 *   notice, this list of conditions and the following disclaimer in the
 *   documentation and/or other materials provided with the distribution.
 *
 * - Neither the name of CodePlex Foundation nor the names of its
 *   contributors may be used to endorse or promote products derived from
 *   this software without specific prior written permission.
 *
 * THIS SOFTWARE IS PROVIDED BY THE COPYRIGHT HOLDERS AND CONTRIBUTORS
 * "AS IS" AND ANY EXPRESS OR IMPLIED WARRANTIES, INCLUDING, BUT NOT
 * LIMITED TO, THE IMPLIED WARRANTIES OF MERCHANTABILITY AND FITNESS FOR
 * A PARTICULAR PURPOSE ARE DISCLAIMED.  IN NO EVENT SHALL THE COPYRIGHT
 * OWNER OR CONTRIBUTORS BE LIABLE FOR ANY DIRECT, INDIRECT, INCIDENTAL,
 * SPECIAL, EXEMPLARY, OR CONSEQUENTIAL DAMAGES (INCLUDING, BUT NOT LIMITED
 * TO, PROCUREMENT OF SUBSTITUTE GOODS OR SERVICES; LOSS OF USE, DATA, OR
 * PROFITS; OR BUSINESS INTERRUPTION) HOWEVER CAUSED AND ON ANY THEORY OF
 * LIABILITY, WHETHER IN CONTRACT, STRICT LIABILITY, OR TORT (INCLUDING
 * NEGLIGENCE OR OTHERWISE) ARISING IN ANY WAY OUT OF THE USE OF THIS
 * SOFTWARE, EVEN IF ADVISED OF THE POSSIBILITY OF SUCH DAMAGE.
 */

(function( $ ){

    const DRAWER_INTERNAL_CACHE = Symbol("DRAWER_INTERNAL_CACHE");

    /**
     * @class CacheRecord
     * @memberof OpenSeadragon
     * @classdesc Cached Data Record, the cache object. Keeps only latest object type required.
     *
     * This class acts like the Maybe type:
     *  - it has 'loaded' flag indicating whether the tile data is ready
     *  - it has 'data' property that has value if loaded=true
     *
     * Furthermore, it has a 'getData' function that returns a promise resolving
     * with the value on the desired type passed to the function.
     */
    $.CacheRecord = class {
        constructor() {
            this.revive();
        }

        /**
         * Access the cache record data directly. Preferred way of data access.
         * Might be undefined if this.loaded = false.
         * You can access the data in synchronous way, but the data might not be available.
         * If you want to access the data indirectly (await), use this.transformTo or this.getDataAs
         * @returns {any}
         */
        get data() {
            return this._data;
        }

        /**
         * Read the cache type. The type can dynamically change, but should be consistent at
         * one point in the time. For available types see the OpenSeadragon.Convertor, or the tutorials.
         * @returns {string}
         */
        get type() {
            return this._type;
        }

        /**
         * Await ongoing process so that we get cache ready on callback.
         * @returns {OpenSeadragon.Promise<?>}
         */
        await() {
            if (!this._promise) { //if not cache loaded, do not fail
                return $.Promise.resolve();
            }
            return this._promise;
        }

        getImage() {
            $.console.error("[CacheRecord.getImage] options.image is deprecated. Moreover, it might not work" +
                " correctly as the cache system performs conversion asynchronously in case the type needs to be converted.");
            this.transformTo("image");
            return this.data;
        }

        getRenderedContext() {
            $.console.error("[CacheRecord.getRenderedContext] options.getRenderedContext  is deprecated. Moreover, it might not work" +
                " correctly as the cache system performs conversion asynchronously in case the type needs to be converted.");
            this.transformTo("context2d");
            return this.data;
        }

        /**
         * Set the cache data. Asynchronous.
         * @param {any} data
         * @param {string} type
         * @returns {OpenSeadragon.Promise<?>} the old cache data that has been overwritten
         */
        setDataAs(data, type) {
            //allow set data with destroyed state, destroys the data if necessary
            $.console.assert(data !== undefined && data !== null, "[CacheRecord.setDataAs] needs valid data to set!");
            if (this._conversionJobQueue) {
                //delay saving if ongiong conversion, these were registered first
                let resolver = null;
                const promise = new $.Promise((resolve, reject) => {
                    resolver = resolve;
                });
                this._conversionJobQueue.push(() => resolver(this._overwriteData(data, type)));
                return promise;
            }
            return this._overwriteData(data, type);
        }

        /**
         * Access the cache record data indirectly. Preferred way of data access. Asynchronous.
         * @param {string} [type=undefined]
         * @param {boolean} [copy=true] if false and same type is retrieved as the cache type,
         *  copy is not performed: note that this is potentially dangerous as it might
         *  introduce race conditions (you get a cache data direct reference you modify).
         * @returns {OpenSeadragon.Promise<?>} desired data type in promise, undefined if the cache was destroyed
         */
        getDataAs(type = undefined, copy = true) {
            if (this.loaded) {
                if (type === this._type) {
                    return copy ? $.convertor.copy(this._tRef, this._data, type || this._type) : this._promise;
                }
                return this._transformDataIfNeeded(this._tRef, this._data, type || this._type, copy) || this._promise;
            }
            return this._promise.then(data => this._transformDataIfNeeded(this._tRef, data, type || this._type, copy) || data);
        }

        _transformDataIfNeeded(referenceTile, data, type, copy) {
            //might get destroyed in meanwhile
            if (this._destroyed) {
                return $.Promise.resolve();
            }

            let result;
            if (type !== this._type) {
                result = $.convertor.convert(referenceTile, data, this._type, type);
            } else if (copy) { //convert does not copy data if same type, do explicitly
                result = $.convertor.copy(referenceTile, data, type);
            }
            if (result) {
                return result.then(finalData => {
                    if (this._destroyed) {
                        $.convertor.destroy(finalData, type);
                        return undefined;
                    }
                    return finalData;
                });
            }
            return false; // no conversion needed, parent function returns item as-is
        }

        /**
         * @private
         * Access of the data by drawers, synchronous function. Should always access a valid main cache, e.g.
         * cache swap performed on working cache (consumeCache()) must be synchronous such that cache is always
         * ready to render, and swaps atomically between render calls.
         *
         * @param {OpenSeadragon.DrawerBase} drawer drawer reference which requests the data: the drawer
         *   defines the supported formats this cache should return **synchronously**
         * @param {OpenSeadragon.Tile} tileToDraw reference to the tile that is in the process of drawing and
         *   for which we request the data; if we attempt to draw such tile while main cache target is destroyed,
         *   attempt to reset the tile state to force system to re-download it again
         * @returns {any|undefined} desired data if available, undefined if conversion must be done
         */
        getDataForRendering(drawer, tileToDraw ) {
            const supportedTypes = drawer.getSupportedDataFormats(),
                keepInternalCopy = drawer.options.usePrivateCache;
            if (this.loaded && supportedTypes.includes(this.type)) {
                return this.data;
            }

            if (this._destroyed) {
                $.console.error("Attempt to draw tile with destroyed main cache!");
                tileToDraw._unload();  // try to restore the state so that the tile is later on fetched again
                return undefined;
            }

            let internalCache = this[DRAWER_INTERNAL_CACHE];
            internalCache = internalCache && internalCache[drawer.getId()];
            if (keepInternalCopy && !internalCache) {
                $.console.warn("Attempt to render %s that is not prepared with drawer requesting " +
                    "internal cache! This might introduce artifacts.", this.toString());

                this.prepareForRendering(drawer.getId(), supportedTypes, keepInternalCopy)
                    .then(() => this._triggerNeedsDraw());
                return undefined;
            }

            if (internalCache) {
                internalCache.withTileReference(this._tRef);
            } else {
                internalCache = this;
            }

            // Cache in the process of loading, no-op
            if (!internalCache.loaded) {
                this._triggerNeedsDraw();
                return undefined;
            }

            if (!supportedTypes.includes(internalCache.type)) {
                $.console.warn("Attempt to render %s that is not prepared for current drawer " +
                    "supported format: the preparation should've happened after tile processing has finished.", this.toString());

                internalCache.transformTo(supportedTypes.length > 1 ? supportedTypes : supportedTypes[0])
                    .then(() => this._triggerNeedsDraw());
                return undefined; // type is NOT compatible
            }
            return internalCache.data;
        }

        /**
         * Should not be called if cache type is already among supported types
         * @private
         * @param drawerId
         * @param supportedTypes
         * @param keepInternalCopy

         * @return {OpenSeadragon.Promise<OpenSeadragon.SimpleCacheRecord|OpenSeadragon.CacheRecord> | null}
         *   reference to the cache processed for drawer rendering requirements, or null on error
         */
        prepareForRendering(drawerId, supportedTypes, keepInternalCopy = true) {
            // if not internal copy and we have no data, or we are ready to render, exit
            if (!this.loaded || supportedTypes.includes(this.type)) {
                return $.Promise.resolve(this);
            }

            if (!keepInternalCopy) {
                return this.transformTo(supportedTypes);
            }

            // we can get here only if we want to render incompatible type
            let internalCache = this[DRAWER_INTERNAL_CACHE];
            if (!internalCache) {
                internalCache = this[DRAWER_INTERNAL_CACHE] = {};
            }

            internalCache = internalCache[drawerId];
            if (internalCache) {
                // already done
                return $.Promise.resolve(this);
            }

            internalCache = this[DRAWER_INTERNAL_CACHE][drawerId] = new $.SimpleCacheRecord();
            const conversionPath = $.convertor.getConversionPath(this.type, supportedTypes);
            if (!conversionPath) {
                $.console.error(`[getDataForRendering] Conversion ${this.type} ---> ${supportedTypes} cannot be done!`);
                return $.Promise.resolve(this);
            }
            internalCache.withTileReference(this._tRef);
            const selectedFormat = conversionPath[conversionPath.length - 1].target.value;
            return $.convertor.convert(this._tRef, this.data, this.type, selectedFormat).then(data => {
                internalCache.setDataAs(data, selectedFormat);  // synchronous, SimpleCacheRecord call
                return internalCache;
            });
        }

        /**
         * Transform cache to desired type and get the data after conversion.
         * Does nothing if the type equals to the current type. Asynchronous.
         * Transformation is LAZY, meaning conversions are performed only to
         * match the last conversion request target type.
         * @param {string|[string]} type if array provided, the system will
         *   try to optimize for the best type to convert to.
         * @return {OpenSeadragon.Promise<?>}
         */
        transformTo(type = this._type) {
            if (!this.loaded) {
                this._conversionJobQueue = this._conversionJobQueue || [];
                let resolver = null;
                const promise = new $.Promise((resolve, reject) => {
                    resolver = resolve;
                });

                // Todo consider submitting only single tranform job to queue: any other transform calls will have
                //  no effect, the last one decides the target format
                this._conversionJobQueue.push(() => {
                    if (this._destroyed) {
                        return;
                    }
                    //must re-check types since we perform in a queue of conversion requests
                    if ((typeof type === "string" && type !== this._type) || (Array.isArray(type) && !type.includes(this._type))) {
                        //ensures queue gets executed after finish
                        this._convert(this._type, type);
                        this._promise.then(data => resolver(data));
                    } else {
                        //must ensure manually, but after current promise finished, we won't wait for the following job
                        this._promise.then(data => {
                            this._checkAwaitsConvert();
                            return resolver(data);
                        });
                    }
                });
                return promise;
            }

            if ((typeof type === "string" && type !== this._type) || (Array.isArray(type) && !type.includes(this._type))) {
                this._convert(this._type, type);
            }
            return this._promise;
        }

        /**
         * If cache ceases to be the primary one, free data
         * @private
         */
        destroyInternalCache() {
            const internal = this[DRAWER_INTERNAL_CACHE];
            if (internal) {
                for (let iCache in internal) {
                    internal[iCache].destroy();
                }
                delete this[DRAWER_INTERNAL_CACHE];
            }
        }

        /**
         * Conversion requires tile references:
         * keep the most 'up to date' ref here. It is called and managed automatically.
         * @param {OpenSeadragon.Tile} ref
         * @private
         */
        withTileReference(ref) {
            this._tRef = ref;
        }

        /**
         * Get cache description. Used for system messages and errors.
         * @return {string}
         */
        toString() {
            const tile = this._tRef || (this._tiles.length && this._tiles[0]);
            return tile ? `Cache ${this.type} [used e.g. by ${tile.toString()}]` : `Orphan cache!`;
        }

        /**
         * Set initial state, prepare for usage.
         * Must not be called on active cache, e.g. first call destroy().
         */
        revive() {
            $.console.assert(!this.loaded && !this._type, "[CacheRecord::revive] must not be called when loaded!");
            this._tiles = [];
            this._data = null;
            this._type = null;
            this.loaded = false;
            this._promise = null;
            this._destroyed = false;
        }

        /**
         * Free all the data and call data destructors if defined.
         */
        destroy() {
            if (!this._destroyed) {
                delete this._conversionJobQueue;
                this._destroyed = true;

                // make sure this gets destroyed even if loaded=false
                if (this.loaded) {
                    this._destroySelfUnsafe(this._data, this._type);
                } else if (this._promise) {
                    const oldType = this._type;
                    this._promise.then(x => this._destroySelfUnsafe(x, oldType));
                }
            }

        }

        _destroySelfUnsafe(data, type) {
            // ensure old data destroyed
            $.convertor.destroy(data, type);
            this.destroyInternalCache();
            // might've got revived in meanwhile if async ...
            if (!this._destroyed) {
                return;
            }
            this.loaded = false;
            this._tiles = null;
            this._data = null;
            this._type = null;
            this._tRef = null;
            this._promise = null;
        }

        /**
         * Add tile dependency on this record
         * @param tile
         * @param data can be null|undefined => optimization, will skip data initialization and just adds tile reference
         * @param type
         */
        addTile(tile, data, type) {
            if (this._destroyed) {
                return;
            }
            $.console.assert(tile, '[CacheRecord.addTile] tile is required');

            // first come first served, data for existing tiles is NOT overridden
            if (data !== undefined && data !== null && this._tiles.length < 1) {
                // Since we IGNORE new data if already initialized, we support 'data getter'
                if (typeof data === 'function') {
                    data = data();
                }

                // in case we attempt to write to existing data object
                if (this.type && this._promise) {
                    if (data instanceof $.Promise) {
                        this._promise = data.then(d => {
                            this._overwriteData(d, type);
                        });
                    } else {
                        this._overwriteData(data, type);
                    }
                } else {
                    // If we receive async callback, we consume the async state
                    if (data instanceof $.Promise) {
                        this._promise = data.then(d => {
                            this._data = d;
                            this.loaded = true;
                            return d;
                        });
                        this._data = null;
                    } else {
                        this._promise = $.Promise.resolve(data);
                        this._data = data;
                        this.loaded = true;
                    }

                    this._type = type;
                }
                this._tiles.push(tile);
            } else if (!this._tiles.includes(tile) && this.type && this._promise) {
                // here really check we are loaded, since if optimization allows sending no data and we add tile without
                // proper initialization it is a bug
                this._tiles.push(tile);
            } else {
                $.console.warn("Tile %s caching attempt without data argument on uninitialized cache entry!", tile);
            }
        }

        /**
         * Remove tile dependency on this record.
         * @param tile
         * @returns {Boolean} true if record removed
         */
        removeTile(tile) {
            if (this._destroyed) {
                return false;
            }
            for (let i = 0; i < this._tiles.length; i++) {
                if (this._tiles[i] === tile) {
                    this._tiles.splice(i, 1);
                    if (this._tRef === tile) {
                        // keep fresh ref
                        this._tRef = this._tiles[i - 1];
                    }
                    return true;
                }
            }
            $.console.warn('[CacheRecord.removeTile] trying to remove unknown tile', tile);
            return false;
        }

        /**
         * Get the amount of tiles sharing this record.
         * @return {number}
         */
        getTileCount() {
            return this._tiles ? this._tiles.length : 0;
        }

        /**
         * Private conversion that makes sure collided requests are
         * processed eventually
         * @private
         */
        _checkAwaitsConvert() {
            if (!this._conversionJobQueue || this._destroyed) {
                return;
            }
            //let other code finish first
            setTimeout(() => {
                //check again, meanwhile things might've changed
                if (!this._conversionJobQueue || this._destroyed) {
                    return;
                }
                const job = this._conversionJobQueue[0];
                this._conversionJobQueue.splice(0, 1);
                if (this._conversionJobQueue.length === 0) {
                    delete this._conversionJobQueue;
                }
                job();
            });
        }

        _triggerNeedsDraw() {
            if (this._tiles.length > 0) {
                this._tiles[0].tiledImage.viewer.forceRedraw();
            }
        }

        /**
         * Safely overwrite the cache data and return the old data
         * @private
         */
        _overwriteData(data, type) {
            if (this._destroyed) {
                //we have received the ownership of the data, destroy it too since we are destroyed
                $.convertor.destroy(data, type);
                return $.Promise.resolve();
            }
            if (this.loaded) {
                // No-op if attempt to replace with the same object
                if (this._data === data && this._type === type) {
                    return this._promise;
                }
                $.convertor.destroy(this._data, this._type);
                this._type = type;
                this._data = data;
                this._promise = $.Promise.resolve(data);
                const internal = this[DRAWER_INTERNAL_CACHE];
                if (internal) {
                    for (let iCache in internal) {
                        internal[iCache].setDataAs(data, type);
                    }
                }
                this._triggerNeedsDraw();
                return this._promise;
            }
            return this._promise.then(() => {
                // No-op if attempt to replace with the same object
                if (this._data === data && this._type === type) {
                    return this._data;
                }
                $.convertor.destroy(this._data, this._type);
                this._type = type;
                this._data = data;
                this._promise = $.Promise.resolve(data);
                const internal = this[DRAWER_INTERNAL_CACHE];
                if (internal) {
                    for (let iCache in internal) {
                        internal[iCache].setDataAs(data, type);
                    }
                }
                this._triggerNeedsDraw();
                return this._data;
            });
        }

        /**
         * Private conversion that makes sure the cache knows its data is ready
         * @param to array or a string - allowed types
         * @param from string - type origin
         * @private
         */
        _convert(from, to) {
            const convertor = $.convertor,
                conversionPath = convertor.getConversionPath(from, to);
            if (!conversionPath) {
                $.console.error(`[CacheRecord._convert] Conversion ${from} ---> ${to} cannot be done!`);
                return; //no-op
            }

            const originalData = this._data,
                stepCount = conversionPath.length,
                _this = this,
                convert = (x, i) => {
                    if (i >= stepCount) {
                        _this._data = x;
                        _this.loaded = true;
                        _this._checkAwaitsConvert();
                        return $.Promise.resolve(x);
                    }
                    let edge = conversionPath[i];
                    let y = edge.transform(_this._tRef, x);
                    if (y === undefined) {
                        _this.loaded = false;
                        throw `[CacheRecord._convert] data mid result undefined value (while converting using ${edge}})`;
                    }
                    convertor.destroy(x, edge.origin.value);
                    const result = $.type(y) === "promise" ? y : $.Promise.resolve(y);
                    return result.then(res => convert(res, i + 1));
                };

            this.loaded = false;
            this._data = undefined;
            // Read target type from the conversion path: [edge.target] = Vertex, its value=type
            this._type = conversionPath[stepCount - 1].target.value;
            this._promise = convert(originalData, 0);
        }
    };

    /**
     * @class SimpleCacheRecord
     * @memberof OpenSeadragon
     * @classdesc Simple cache record without robust support for async access. Meant for internal use only.
     *
     * This class acts like the Maybe type:
     *  - it has 'loaded' flag indicating whether the tile data is ready
     *  - it has 'data' property that has value if loaded=true
     *
     * This class supposes synchronous access, no collision of transform calls.
     * It also does not record tiles nor allows cache/tile sharing.
     * @private
     */
    $.SimpleCacheRecord = class {
        constructor(preferredTypes) {
            this._data = null;
            this._type = null;
            this.loaded = false;
            this.format = Array.isArray(preferredTypes) ? preferredTypes : null;
        }

        /**
         * Sync access to the data
         * @returns {any}
         */
        get data() {
            return this._data;
        }

        /**
         * Sync access to the current type
         * @returns {string}
         */
        get type() {
            return this._type;
        }

        /**
         * Must be called before transformTo or setDataAs. To keep
         * compatible api with CacheRecord where tile refs are known.
         * @param {OpenSeadragon.Tile} referenceTile reference tile for conversion
         */
        withTileReference(referenceTile) {
            this._temporaryTileRef = referenceTile;
        }

        /**
         * Transform cache to desired type and get the data after conversion.
         * Does nothing if the type equals to the current type. Asynchronous.
         * @param {string|[string]} type if array provided, the system will
         *   try to optimize for the best type to convert to.
         * @returns {OpenSeadragon.Promise<?>}
         */
        transformTo(type) {
            $.console.assert(this._temporaryTileRef, "SimpleCacheRecord needs tile reference set before update operation!");
            const convertor = $.convertor,
                conversionPath = convertor.getConversionPath(this._type, type);
            if (!conversionPath) {
                $.console.error(`[SimpleCacheRecord.transformTo] Conversion ${this._type} ---> ${type} cannot be done!`);
                return $.Promise.resolve(); //no-op
            }

            const stepCount = conversionPath.length,
                _this = this,
                convert = (x, i) => {
                    if (i >= stepCount) {
                        _this._data = x;
                        _this.loaded = true;
                        _this._temporaryTileRef = null;
                        return $.Promise.resolve(x);
                    }
                    let edge = conversionPath[i];
                    try {
                        // no test for y - less robust approach
                        let y = edge.transform(this._temporaryTileRef, x);
                        convertor.destroy(x, edge.origin.value);
                        const result = $.type(y) === "promise" ? y : $.Promise.resolve(y);
                        return result.then(res => convert(res, i + 1));
                    } catch (e) {
                        _this.loaded = false;
                        _this._temporaryTileRef = null;
                        throw e;
                    }
                };

            this.loaded = false;
            // Read target type from the conversion path: [edge.target] = Vertex, its value=type
            this._type = conversionPath[stepCount - 1].target.value;
            const promise = convert(this._data, 0);
            this._data = undefined;
            return promise;
        }

        /**
         * Free all the data and call data destructors if defined.
         */
        destroy() {
            $.convertor.destroy(this._data, this._type);
            this._data = null;
            this._type = null;
        }

        /**
         * Safely overwrite the cache data and return the old data
         * @private
         */
        setDataAs(data, type) {
            // no check for state, users must ensure compatibility manually
            $.convertor.destroy(this._data, this._type);
            this._type = type;
            this._data = data;
            this.loaded = true;
        }
    };

    /**
     * @class TileCache
     * @memberof OpenSeadragon
     * @classdesc Stores all the tiles displayed in a {@link OpenSeadragon.Viewer}.
     * You generally won't have to interact with the TileCache directly.
     * @param {Object} options - Configuration for this TileCache.
     * @param {Number} [options.maxImageCacheCount] - See maxImageCacheCount in
     * {@link OpenSeadragon.Options} for details.
     */
    $.TileCache = class {
        constructor( options ) {
            options = options || {};

            this._maxCacheItemCount = options.maxImageCacheCount || $.DEFAULT_SETTINGS.maxImageCacheCount;
            this._tilesLoaded = [];
            this._zombiesLoaded = [];
            this._zombiesLoadedCount = 0;
            this._cachesLoaded = [];
            this._cachesLoadedCount = 0;
        }

        /**
         * @returns {Number} The total number of tiles that have been loaded by
         * this TileCache. Note that the tile might be recorded here mutliple times,
         * once for each cache it uses.
         */
        numTilesLoaded() {
            return this._tilesLoaded.length;
        }

        /**
         * @returns {Number} The total number of cached objects (+ zombies)
         */
        numCachesLoaded() {
            return this._zombiesLoadedCount + this._cachesLoadedCount;
        }

        /**
         * Caches the specified tile, removing an old tile if necessary to stay under the
         * maxImageCacheCount specified on construction. Note that if multiple tiles reference
         * the same image, there may be more tiles than maxImageCacheCount; the goal is to keep
         * the number of images below that number. Note, as well, that even the number of images
         * may temporarily surpass that number, but should eventually come back down to the max specified.
         * @private
         * @param {Object} options - Cache creation parameters.
         * @param {OpenSeadragon.Tile} options.tile - The tile to cache.
         * @param {?String} [options.cacheKey=undefined] - Cache Key to use. Defaults to options.tile.cacheKey
         * @param {String} options.tile.cacheKey - The unique key used to identify this tile in the cache.
         *   Used if options.cacheKey not set.
         * @param {Image} options.image - The image of the tile to cache. Deprecated.
         * @param {*} options.data - The data of the tile to cache. If `typeof data === 'function'` holds,
         *   the data is called to obtain the data item: this is an optimization to load data only when necessary.
         * @param {string} [options.dataType] - The data type of the tile to cache. Required.
         * @param {Number} [options.cutoff=0] - If adding this tile goes over the cache max count, this
         *   function will release an old tile. The cutoff option specifies a tile level at or below which
         *   tiles will not be released.
         * @returns {OpenSeadragon.CacheRecord} - The cache record the tile was attached to.
         */
        cacheTile( options ) {
            $.console.assert( options, "[TileCache.cacheTile] options is required" );
            const theTile = options.tile;
            $.console.assert( theTile, "[TileCache.cacheTile] options.tile is required" );
            $.console.assert( theTile.cacheKey, "[TileCache.cacheTile] options.tile.cacheKey is required" );

            if (options.image instanceof Image) {
                $.console.warn("[TileCache.cacheTile] options.image is deprecated!" );
                options.data = options.image;
                options.dataType = "image";
            }

            let cacheKey = options.cacheKey || theTile.cacheKey;

            let cacheRecord = this._cachesLoaded[cacheKey];
            if (!cacheRecord) {
                if (options.data === undefined) {
                    $.console.error("[TileCache.cacheTile] options.image was renamed to options.data. '.image' attribute " +
                        "has been deprecated and will be removed in the future.");
                    options.data = options.image;
                }

                cacheRecord = this._zombiesLoaded[cacheKey];
                if (cacheRecord) {
                    // zombies should not be (yet) destroyed, but if we encounter one...
                    if (cacheRecord._destroyed) {
                        cacheRecord.revive();
                    } else {
                        // if zombie ready, do not overwrite its data
                        delete options.data;
                    }
                    delete this._zombiesLoaded[cacheKey];
                    this._zombiesLoadedCount--;
                    this._cachesLoaded[cacheKey] = cacheRecord;
                    this._cachesLoadedCount++;
                } else {
                    //allow anything but undefined, null, false (other values mean the data was set, for example '0')
                    const validData = options.data !== undefined && options.data !== null && options.data !== false;
                    $.console.assert( validData, "[TileCache.cacheTile] options.data is required to create an CacheRecord" );
                    cacheRecord = this._cachesLoaded[cacheKey] = new $.CacheRecord();
                    this._cachesLoadedCount++;
                }
            }

            if (!options.dataType) {
                $.console.error("[TileCache.cacheTile] options.dataType is newly required. " +
                    "For easier use of the cache system, use the tile instance API.");

                // We need to force data acquisition now to guess the type
                if (typeof options.data === 'function') {
                    $.console.error("[TileCache.cacheTile] options.dataType is mandatory " +
                        " when data item is a callback!");
                }
                options.dataType = $.convertor.guessType(options.data);
            }

            cacheRecord.addTile(theTile, options.data, options.dataType);
            this._freeOldRecordRoutine(theTile, options.cutoff || 0);
            return cacheRecord;
        }

        /**
         * Changes cache key
         * @private
         * @param {Object} options - Cache creation parameters.
         * @param {String} options.oldCacheKey - Current key
         * @param {String} options.newCacheKey - New key to set
         * @return {OpenSeadragon.CacheRecord | null}
         */
        renameCache( options ) {
            const newKey = options.newCacheKey,
                oldKey = options.oldCacheKey;
            let originalCache = this._cachesLoaded[oldKey];

            if (!originalCache) {
                originalCache = this._zombiesLoaded[oldKey];
                $.console.assert( originalCache, "[TileCache.renameCache] oldCacheKey must reference existing cache!" );
                if (this._zombiesLoaded[newKey]) {
                    $.console.error("Cannot rename zombie cache %s to %s: the target cache is occupied!",
                        oldKey, newKey);
                    return null;
                }
                this._zombiesLoaded[newKey] = originalCache;
                delete this._zombiesLoaded[oldKey];
            } else if (this._cachesLoaded[newKey]) {
                $.console.error("Cannot rename cache %s to %s: the target cache is occupied!",
                    oldKey, newKey);
                return null; // do not remove, we perform additional fixes on caches later on when swap occurred
            } else {
                this._cachesLoaded[newKey] = originalCache;
                delete this._cachesLoaded[oldKey];
            }

            for (let tile of originalCache._tiles) {
                tile.reflectCacheRenamed(oldKey, newKey);
            }

            // do not call free old record routine, we did not increase cache size
            return originalCache;
        }

        /**
         * Reads a cache if it exists and creates a new copy of a target, different cache if it does not
         * @private
         * @param {Object} options
         * @param {OpenSeadragon.Tile} options.tile - The tile to own ot add record for the cache.
         * @param {String} options.copyTargetKey - The unique key used to identify this tile in the cache.
         * @param {String} options.newCacheKey - The unique key the copy will be created for.
         * @param {String} [options.desiredType=undefined] - For optimization purposes, the desired type. Can
         *   be ignored.
         * @param {Number} [options.cutoff=0] - If adding this tile goes over the cache max count, this
         *   function will release an old tile. The cutoff option specifies a tile level at or below which
         *   tiles will not be released.
         * @returns {OpenSeadragon.Promise<OpenSeadragon.CacheRecord>} - New record.
         */
        cloneCache(options) {
            const theTile = options.tile;
            const cacheKey = options.copyTargetKey;
            const cacheRecord = this._cachesLoaded[cacheKey] || this._zombiesLoaded[cacheKey];
            $.console.assert(cacheRecord, "[TileCache.cloneCache] attempt to clone non-existent cache %s!", cacheKey);
            $.console.assert(!this._cachesLoaded[options.newCacheKey],
                "[TileCache.cloneCache] attempt to copy clone to existing cache %s!", options.newCacheKey);

            const desiredType = options.desiredType || undefined;
            return cacheRecord.getDataAs(desiredType, true).then(data => {
                let newRecord = this._cachesLoaded[options.newCacheKey] = new $.CacheRecord();
                newRecord.addTile(theTile, data, cacheRecord.type);
                this._cachesLoadedCount++;
                this._freeOldRecordRoutine(theTile, options.cutoff || 0);
                return newRecord;
            });
        }

        /**
         * Consume cache by another cache
         * @private
         * @param {Object} options
         * @param {OpenSeadragon.Tile} options.tile - The tile to own ot add record for the cache.
         * @param {String} options.victimKey - Cache that will be erased. In fact, the victim _replaces_ consumer,
         *   inheriting its tiles and key.
         * @param {String} options.consumerKey - The cache that consumes the victim. In fact, it gets destroyed and
         *   replaced by victim, which inherits all its metadata.
         * @param {Boolean} options.tileAllowNotLoaded - if true, tile that is not loaded is also processed,
         *   this is internal parameter used in tile-loaded completion routine, as we need to prepare tile but
         *   it is not yet loaded and cannot be marked as so (otherwise the system would think it is ready)
         */
        consumeCache(options) {
            const victim = this._cachesLoaded[options.victimKey],
                tile = options.tile;
            if (!victim || (!options.tileAllowNotLoaded && !tile.loaded && !tile.loading)) {
                $.console.warn("Attempt to consume non-existent cache: this is probably a bug!");
                return;
            }
            const consumer = this._cachesLoaded[options.consumerKey];
            let tiles = [...tile.getCache()._tiles];

            if (consumer) {
                // We need to avoid async execution here: replace consumer instead of overwriting the data.
                const iterateTiles = [...consumer._tiles];  // unloadCacheForTile() will modify the array, use a copy
                for (let tile of iterateTiles) {
                    this.unloadCacheForTile(tile, options.consumerKey, true, false);
                }
            }
            if (this._cachesLoaded[options.consumerKey]) {
                console.error("The routine should've freed cache!");
            }
            // Just swap victim to become new consumer
            const resultCache = this.renameCache({
                oldCacheKey: options.victimKey,
                newCacheKey: options.consumerKey
            });

            if (resultCache) {
                // Only one cache got working item, other caches were idle: update cache: add the new cache
                // we can add since we removed above with unloadCacheForTile()
                for (let tile of tiles) {
                    if (tile !== options.tile) {
                        tile.addCache(options.consumerKey, resultCache.data, resultCache.type, true, false);
                    }
                }
            }
        }

        /**
         * @private
         * This method ensures other tiles are restored if one of the tiles
         * was requested restore().
         * @param tile
         * @param originalCache
         * @param freeIfUnused if true, zombie is not created
         */
        restoreTilesThatShareOriginalCache(tile, originalCache, freeIfUnused) {
            for (let t of originalCache._tiles) {
                this.unloadCacheForTile(t, t.cacheKey, freeIfUnused, false);
                delete t._caches[t.cacheKey];
                t.cacheKey = t.originalCacheKey;
            }
        }

        _freeOldRecordRoutine(theTile, cutoff) {
            let insertionIndex = this._tilesLoaded.length,
                worstTileIndex = -1;

            // Note that just because we're unloading a tile doesn't necessarily mean
            // we're unloading its cache records. With repeated calls it should sort itself out, though.
            if ( this._cachesLoadedCount + this._zombiesLoadedCount > this._maxCacheItemCount ) {
                //prefer zombie deletion, faster, better
                if (this._zombiesLoadedCount > 0) {
                    for (let zombie in this._zombiesLoaded) {
                        this._zombiesLoaded[zombie].destroy();
                        delete this._zombiesLoaded[zombie];
                        this._zombiesLoadedCount--;
                        break;
                    }
                } else {
                    let worstTile = null;
                    let prevTile, worstTime, worstLevel, prevTime, prevLevel;

                    for ( let i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
                        prevTile = this._tilesLoaded[ i ];

                        if ( prevTile.level <= cutoff ||
                            prevTile.beingDrawn ||
                            prevTile.loading ||
                            prevTile.processing ) { //todo exempt from deletion, or block this routine on data updates
                            continue;
                        }
                        if ( !worstTile ) {
                            worstTile       = prevTile;
                            worstTileIndex  = i;
                            continue;
                        }

                        prevTime    = prevTile.lastTouchTime;
                        worstTime   = worstTile.lastTouchTime;
                        prevLevel   = prevTile.level;
                        worstLevel  = worstTile.level;

                        if ( prevTime < worstTime ||
                            ( prevTime === worstTime && prevLevel > worstLevel )) {
                            worstTile       = prevTile;
                            worstTileIndex  = i;
                        }
                    }

                    if ( worstTile && worstTileIndex >= 0 ) {
                        this._unloadTile(worstTile, true);
                        insertionIndex = worstTileIndex;
                    }
                }
            }

            if (theTile.getCacheSize() === 0) {
                this._tilesLoaded[ insertionIndex ] = theTile;
            } else if (worstTileIndex >= 0) {
                //tile is already recorded, do not add tile, but remove the tile at insertion index
                this._tilesLoaded.splice(insertionIndex, 1);
            }
        }

        /**
         * Clears all tiles associated with the specified tiledImage.
         * @param {OpenSeadragon.TiledImage} tiledImage
         */
        clearTilesFor( tiledImage ) {
            $.console.assert(tiledImage, '[TileCache.clearTilesFor] tiledImage is required');
            let tile;

            let cacheOverflows = this._cachesLoadedCount + this._zombiesLoadedCount > this._maxCacheItemCount;
            if (tiledImage._zombieCache && cacheOverflows && this._zombiesLoadedCount > 0) {
                //prefer newer (fresh ;) zombies
                for (let zombie in this._zombiesLoaded) {
                    this._zombiesLoaded[zombie].destroy();
                    delete this._zombiesLoaded[zombie];
                }
                this._zombiesLoadedCount = 0;
                cacheOverflows = this._cachesLoadedCount > this._maxCacheItemCount;
            }
            for ( let i = this._tilesLoaded.length - 1; i >= 0; i-- ) {
                tile = this._tilesLoaded[ i ];

                if (tile.tiledImage === tiledImage) {
                    if (!tile.loaded) {
                        //iterates from the array end, safe to remove
                        this._tilesLoaded.splice( i, 1 );
                    } else if ( tile.tiledImage === tiledImage ) {
                        this._unloadTile(tile, !tiledImage._zombieCache || cacheOverflows, i);
                    }
                }
            }
        }

        /**
         * Returns reference to all tiles loaded by a particular
         * tiled image item
         * @param {OpenSeadragon.TiledImage|null} tiledImage if null, gets all tiles, else filters out tiles
         *   that belong to a specific image
         */
        getLoadedTilesFor(tiledImage) {
            if (!tiledImage) {
                return [...this._tilesLoaded];
            }
            return this._tilesLoaded.filter(tile => tile.tiledImage === tiledImage);
        }

        /**
         * Get cache record (might be a unattached record, i.e. a zombie)
         * @param cacheKey
         * @returns {OpenSeadragon.CacheRecord|undefined}
         */
        getCacheRecord(cacheKey) {
            $.console.assert(cacheKey, '[TileCache.getCacheRecord] cacheKey is required');
            return this._cachesLoaded[cacheKey] || this._zombiesLoaded[cacheKey];
        }

        /**
         * Delete cache record for a given til
         * @param {OpenSeadragon.Tile} tile
         * @param {string} key cache key
         * @param {boolean} destroy if true, empty cache is destroyed, else left as a zombie
         * @param {boolean} okIfNotExists sometimes we call destruction just to make sure, if true do not report as error
         * @private
         */
        unloadCacheForTile(tile, key, destroy, okIfNotExists) {
            const cacheRecord = this._cachesLoaded[key];
            //unload record only if relevant - the tile exists in the record
            if (cacheRecord) {
                if (cacheRecord.removeTile(tile)) {
                    if (!cacheRecord.getTileCount()) {
                        if (destroy) {
                            // #1 tile marked as destroyed (e.g. too much cached tiles or not a zombie)
                            cacheRecord.destroy();
                        } else {
                            // #2 Tile is a zombie. Do not delete record, reuse.
                            this._zombiesLoaded[key] = cacheRecord;
                            this._zombiesLoadedCount++;
                        }
                        // Either way clear cache
                        delete this._cachesLoaded[key];
                        this._cachesLoadedCount--;
                    }
                    return true;
                }
                $.console.error("[TileCache.unloadCacheForTile] System tried to delete tile from cache it " +
                    "does not belong to! This could mean a bug in the cache system.");
                return false;
            }
            if (!okIfNotExists) {
                $.console.warn("[TileCache.unloadCacheForTile] Attempting to delete missing cache!");
            }
            return false;
        }

        /**
         * Unload tile: this will free the tile data and mark the tile as unloaded.
         * @param {OpenSeadragon.Tile} tile
         * @param {boolean} destroy if set to true, tile data is not preserved as zombies but deleted immediatelly
         */
        unloadTile(tile, destroy = false) {
            if (!tile.loaded) {
                $.console.warn("Attempt to unload already unloaded tile.");
                return;
            }
            const index = this._tilesLoaded.findIndex(x => x === tile);
            this._unloadTile(tile, destroy, index);
        }

        /**
         * @param tile tile to unload
         * @param destroy destroy tile cache if the cache tile counts falls to zero
         * @param deleteAtIndex index to remove the tile record at, will not remove from _tilesLoaded if not set
         * @private
         */
        _unloadTile(tile, destroy, deleteAtIndex) {
            $.console.assert(tile, '[TileCache._unloadTile] tile is required');

            for (let key in tile._caches) {
                //we are 'ok' to remove tile caches here since we later call destroy on tile, otherwise
                //tile has count of its cache size --> would be inconsistent
                this.unloadCacheForTile(tile, key, destroy, false);
            }
            //delete also the tile record
            if (deleteAtIndex !== undefined) {
                this._tilesLoaded.splice( deleteAtIndex, 1 );
            }

            // Possible error: it can happen that unloaded tile gets to this stage. Should it even be allowed to happen?
            if (!tile.loaded) {
                return;
            }

            const tiledImage = tile.tiledImage;
            tile._unload();

            /**
             * Triggered when a tile has just been unloaded from memory.
             @@ -255,12 +668,15 @@ $.TileCache.prototype = {
             * @type {object}
             * @property {OpenSeadragon.TiledImage} tiledImage - The tiled image of the unloaded tile.
             * @property {OpenSeadragon.Tile} tile - The tile which has been unloaded.
             * @property {boolean} destroyed - False if the tile data was kept in the system.
             */
            tiledImage.viewer.raiseEvent("tile-unloaded", {
                tile: tile,
                tiledImage: tiledImage,
                destroyed: destroy
            });
        }
    };

}( OpenSeadragon ));
