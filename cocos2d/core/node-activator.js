/****************************************************************************
 Copyright (c) 2013-2017 Chukong Technologies Inc.

 http://www.cocos.com

 Permission is hereby granted, free of charge, to any person obtaining a copy
 of this software and associated engine source code (the "Software"), a limited,
  worldwide, royalty-free, non-assignable, revocable and  non-exclusive license
 to use Cocos Creator solely to develop games on your target platforms. You shall
  not use Cocos Creator software for developing other software or tools that's
  used for developing games. You are not granted to publish, distribute,
  sublicense, and/or sell copies of Cocos Creator.

 The software or tools in this License Agreement are licensed, not sold.
 Chukong Aipu reserves all rights not expressly granted to you.

 THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
 IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
 FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
 AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
 LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
 OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN
 THE SOFTWARE.
 ****************************************************************************/

var CompScheduler = require('./component-scheduler');
var Flags = require('./platform/CCObject').Flags;
var JsArray = require('./platform/js').array;
var callerFunctor = CC_EDITOR && require('./utils/misc').tryCatchFunctor_EDITOR;

var MAX_POOL_SIZE = 4;

var IsOnLoadStarted = Flags.IsOnLoadStarted;
var IsOnLoadCalled = Flags.IsOnLoadCalled;
var Deactivating = Flags.Deactivating;

var callPreloadInTryCatch = CC_EDITOR && callerFunctor('__preload');
var callOnLoadInTryCatch = CC_EDITOR && callerFunctor('onLoad');
var callOnDestroyInTryCatch = CC_EDITOR && callerFunctor('onDestroy');
var callResetInTryCatch = CC_EDITOR && callerFunctor('resetInEditor');
var callOnFocusInTryCatch = CC_EDITOR && callerFunctor('onFocusInEditor');
var callOnLostFocusInTryCatch = CC_EDITOR && callerFunctor('onLostFocusInEditor');

// for __preload: use internally, no sort
var UnsortedInvoker = cc.Class({
    extends: CompScheduler.LifeCycleInvoker,
    add (comp) {
        this._zero.array.push(comp);
    },
    remove (comp) {
        this._zero.fastRemove(comp);
    },
    cancelInactive () {
        CompScheduler.LifeCycleInvoker.stableRemoveInactive(this._zero);
    },
    invoke () {
        this._invoke(this._zero);
        this._zero.array.length = 0;
    },
});

function createActivateTask () {
    var invokePreload = CompScheduler.createInvokeImpl(CC_EDITOR ? callPreloadInTryCatch : 'c.__preload();');
    var invokeOnLoad = CC_EDITOR ? function (iterator) {
        var array = iterator.array;
        for (iterator.i = 0; iterator.i < array.length; ++iterator.i) {
            let comp = array[iterator.i];
            callOnLoadInTryCatch(comp);
            if (!comp.node._activeInHierarchy) {
                // deactivated during onLoad
                break;
            }
        }
    } : CompScheduler.createInvokeImpl('c.onLoad();if(!c.node._activeInHierarchy)break;');
    return {
        preload: new UnsortedInvoker(invokePreload),
        onLoad: new CompScheduler.OneOffInvoker(invokeOnLoad),
        onEnable: new CompScheduler.OneOffInvoker(CompScheduler.invokeOnEnable)
    };
}

var activateTasksPool = [];
// get invoker temporary
function getActivateTask () {
    return activateTasksPool.pop() || createActivateTask();
}
// release invoker temporary
function putActivateTask (task) {
    if (activateTasksPool.length < MAX_POOL_SIZE) {
        activateTasksPool.push(task);
    }
}

function _componentCorrupted (node, comp, index) {
    if (CC_DEV) {
        cc.errorID(3817, node.name, index);
        console.log('Corrupted component value:', comp);
    }
    if (comp) {
        node._removeComponent(comp);
    }
    else {
        JsArray.removeAt(node._components, index);
    }
}


/**
 * The class used to perform activating and deactivating operations of node and component.
 */
function ctor () {
    // a stack of node's activating tasks
    this._activatingStack = [];
}
var NodeActivator = cc.Class({
    ctor: ctor,
    reset: ctor,

    _activateNodeRecursively (node, preloadInvoker, onLoadInvoker, onEnableInvoker) {
        if (node._objFlags & Deactivating) {
            // en:
            // Forbid reactive the same node during its deactivating procedure
            // to avoid endless loop and simplify the implementation.
            // zh:
            // 对相同节点而言，无法撤销反激活，防止反激活 - 激活 - 反激活的死循环发生。
            // 这样设计简化了一些引擎的实现，而且对调用者来说能保证反激活操作都能成功。
            cc.errorID(3816, node.name);
            return;
        }

        node._activeInHierarchy = true;

        // component maybe added during onEnable, and the onEnable of new component is already called
        // so we should record the origin length
        var originCount = node._components.length;
        // activate components
        for (let i = 0; i < originCount; ++i) {
            let component = node._components[i];
            if (component instanceof cc.Component) {
                this.activateComp(component, preloadInvoker, onLoadInvoker, onEnableInvoker);
            }
            else {
                _componentCorrupted(node, component, i);
                --i;
                --originCount;
            }
        }
        // activate children recursively
        for (let i = 0, len = node._children.length; i < len; ++i) {
            let child = node._children[i];
            if (child._active) {
                this._activateNodeRecursively(child, preloadInvoker, onLoadInvoker, onEnableInvoker);
            }
        }

        node._onPostActivated(true);
    },

    _deactivateNodeRecursively (node) {
        if (CC_TEST || CC_DEV) {
            cc.assert(!(node._objFlags & Deactivating), 'node should not deactivating');
            // ensures _activeInHierarchy is always changing when Deactivating flagged
            cc.assert(node._activeInHierarchy, 'node should not deactivated');
        }
        node._objFlags |= Deactivating;
        node._activeInHierarchy = false;

        // component maybe added during onEnable, and the onEnable of new component is already called
        // so we should record the origin length
        var originCount = node._components.length;
        for (let c = 0; c < originCount; ++c) {
            let component = node._components[c];
            if (component._enabled) {
                cc.director._compScheduler.disableComp(component);

                if (node._activeInHierarchy) {
                    // reactivated from root
                    node._objFlags &= ~Deactivating;
                    return;
                }
            }
        }
        for (let i = 0, len = node._children.length; i < len; ++i) {
            let child = node._children[i];
            if (child._activeInHierarchy) {
                this._deactivateNodeRecursively(child);

                if (node._activeInHierarchy) {
                    // reactivated from root
                    node._objFlags &= ~Deactivating;
                    return;
                }
            }
        }

        node._onPostActivated(false);
        node._objFlags &= ~Deactivating;
    },

    activateNode (node, active) {
        if (active) {
            var task = getActivateTask(node);
            this._activatingStack.push(task);

            this._activateNodeRecursively(node, task.preload, task.onLoad, task.onEnable);
            task.preload.invoke();
            task.onLoad.invoke();
            task.onEnable.invoke();

            this._activatingStack.pop();
            putActivateTask(task);
        }
        else {
            this._deactivateNodeRecursively(node);

            // remove children of this node from previous activating tasks to debounce
            // (this is an inefficient operation but it ensures general case could be implemented in a efficient way)
            var stack = this._activatingStack;
            for (var i = 0; i < stack.length; i++) {
                var lastTask = stack[i];
                lastTask.preload.cancelInactive(node);
                lastTask.onLoad.cancelInactive(node);
                lastTask.onEnable.cancelInactive(node);
            }
        }
        node.emit('active-in-hierarchy-changed', node);
    },

    activateComp: CC_EDITOR ? function (comp, preloadInvoker, onLoadInvoker, onEnableInvoker) {
        if (!(comp._objFlags & IsOnLoadStarted) &&
            (cc.engine._isPlaying || comp.constructor._executeInEditMode)) {
            comp._objFlags |= IsOnLoadStarted;

            if (typeof comp.__preload === 'function') {
                if (preloadInvoker) {
                    preloadInvoker.add(comp);
                }
                else {
                    callPreloadInTryCatch(comp);
                }
            }
            if (comp.onLoad) {
                if (onLoadInvoker) {
                    onLoadInvoker.add(comp);
                }
                else {
                    callOnLoadInTryCatch(comp);
                }
            }

            comp._objFlags |= IsOnLoadCalled;

            if (comp.onLoad && !cc.engine._isPlaying) {
                var focused = Editor.Selection.curActivate('node') === comp.node.uuid;
                if (focused && comp.onFocusInEditor) {
                    callOnFocusInTryCatch(comp);
                }
                else if (comp.onLostFocusInEditor) {
                    callOnLostFocusInTryCatch(comp);
                }
            }
            if ( !CC_TEST ) {
                _Scene.AssetsWatcher.start(comp);
            }
        }
        if (comp._enabled) {
            var deactivatedOnLoading = !comp.node._activeInHierarchy;
            if (deactivatedOnLoading) {
                return;
            }
            cc.director._compScheduler.enableComp(comp, onEnableInvoker);
        }
    } : function (comp, preloadInvoker, onLoadInvoker, onEnableInvoker) {
        if (!(comp._objFlags & IsOnLoadStarted)) {
            comp._objFlags |= IsOnLoadStarted;

            if (typeof comp.__preload === 'function') {
                if (preloadInvoker) {
                    preloadInvoker.add(comp);
                }
                else {
                    comp.__preload();
                }
            }
            if (comp.onLoad) {
                if (onLoadInvoker) {
                    onLoadInvoker.add(comp);
                }
                else {
                    comp.onLoad();
                }
            }

            comp._objFlags |= IsOnLoadCalled;
        }
        if (comp._enabled) {
            var deactivatedOnLoading = !comp.node._activeInHierarchy;
            if (deactivatedOnLoading) {
                return;
            }
            cc.director._compScheduler.enableComp(comp, onEnableInvoker);
        }
    },

    destroyComp: CC_EDITOR ? function (comp) {
        // ensure onDisable called
        cc.director._compScheduler.disableComp(comp);

        if (comp.onDestroy && (comp._objFlags & IsOnLoadCalled)) {
            if (cc.engine._isPlaying || comp.constructor._executeInEditMode) {
                callOnDestroyInTryCatch(comp);
            }
        }
    } : function (comp) {
        // ensure onDisable called
        cc.director._compScheduler.disableComp(comp);

        if (comp.onDestroy && (comp._objFlags & IsOnLoadCalled)) {
            comp.onDestroy();
        }
    },

    resetComp: CC_EDITOR && function (comp) {
        if (typeof comp.resetInEditor === 'function') {
            callResetInTryCatch(comp);
        }
    }
});

module.exports = NodeActivator;
