var async = require('async'),
    comfy = require('comfy'),
    fs = require('fs'),
    path = require('path'),
    Module = require('module').Module,
    MeshApp = require('mesh').MeshApp,
    _ = require('underscore');
    
function checkDirs(directory, callback) {
    var dirMode = 0x1FF;
    
    // check the existence of the requested directory
    path.exists(directory, function(exists) {
        if (! exists) {
            // check the existence of the parent directory
            path.exists(path.dirname(directory), function(parentExists) {
                // if the parent does not exist, then recurse up the tree
                if (! parentExists) {
                    checkDirs(path.dirname(directory), function() {
                        fs.mkdir(directory, dirMode, callback);
                    });
                }
                // otherwise, create the directory and fire the callback
                else {
                    fs.mkdir(directory, dirMode, callback);
                } // if..else
            });
        }
        else {
            callback();
        } // if..else
    });
} // checkDirs

function getConnection(mesh) {
    return comfy.init({
        url: mesh.config.couchurl,
        db: mesh.config.appdb
    });
} // getConnection

function getHandler(mesh, appId, handlerString) {
    var moduleName = handlerString.replace(reHandler, '$1'),
        fnName = handlerString.replace(reHandler, '$2'),
        modulePath = path.resolve('lib/apps/' + appId + '/lib/' + moduleName),
        handler = null;

    try {
        handler = require(modulePath)[fnName];
    }
    catch (e) {
        mesh.log('could not load handler for "' + handlerString + '"');
    } // try..catch
    
    return handler;
} // getHandler

/**
## loadApps
*/
exports.loadApps = function(mesh, callback) {
    var couch = getConnection(mesh);
    
    function downloadApp(appData, appCallback) {
        var attachmentsToDownload = (appData.value.libs || []).length;
        
        mesh.out('synchronizing application: ' + appData.key);
        
        // iterate through the libaries of the appdata
        (appData.value.libs || []).forEach(function(libname) {
            // define the attachment path and the local path
            var attachment = appData.id + '/' + libname,
                localFile = path.resolve('lib/apps/' + attachment);

            checkDirs(path.dirname(localFile), function() {
                couch.get(attachment, function(error, res) {
                    attachmentsToDownload -= 1;
                    
                    if (! error) {
                        fs.writeFileSync(localFile, res);

                        mesh.log('Updated ' + path.basename(attachment) + ' --> ' + path.basename(localFile));
                        if (attachmentsToDownload <= 0) {
                            appCallback();
                        } // if
                    }
                    else {
                        mesh.out('!{red}Unable to download attachment: {0}', attachment);

                        if (attachmentsToDownload <= 0) {
                            appCallback();
                        } // if
                    }
                }, { parseResponse: false });
            });
        });
    } // downloadLibrary
    
    // TODO: read apps into mesh apps
    // TODO: load routes from apps
    // TODO: load jobs from apps
    
    couch.get('_design/default/_view/apps', function(error, res) {
        var apps = [];
        
        if (error) {
            mesh.out('!{red}Unable to find applications in couchdb');
            callback();
        }
        else {
            // initialise the list of stack apps
            res.rows.forEach(function(appData) {
                var appPath = path.resolve(__dirname, '../apps/' + appData.id);
                
                // create the mesh app
                apps.push(new MeshApp(appPath, _.extend({
                    id: appData.id,
                    title: appData.title
                }, appData.value)));
            });
            
            // if we are the master process, then download applications
            if (mesh.cluster.isMaster) {
                async.forEach(res.rows, downloadApp, function() {
                    mesh.out('synchronized application resources');
                    if (callback) {
                        callback(apps);
                    } // if
                });
            }
            // otherwise, just fire the callback
            else if (callback) {
                callback(apps);
            } // if..else
        } // if..else
    });
}; // loadApps

/**
## loadJobs
*/
exports.loadJobs = function(mesh, callback) {
    // ensure we have a callback
    callback = callback || function() {};
    
    var couch = getConnection(mesh);
    
    function registerJob(jobRow, jobCallback) {
        var jobData = jobRow.value;
        
        // initialise the job data in the format mesh expects
        jobData.title = jobRow.key;
        jobData.run = getHandler(mesh, jobRow.id, jobData.handler);
        
        mesh.registerJob(jobData);
        jobCallback();
    } // registerJob
    
    couch.get('_design/default/_view/jobs', function(error, res) {
        if (error) {
            mesh.out('!{red}Unable to load jobs from couchdb');
            callback();
        }
        else {
            async.forEach(res.rows, registerJob, function() {
                mesh.log('loaded ' + res.rows.length + ' jobs into steelmesh');
                callback();
            });
        } // if..else
    });    
}; // loadJobs

exports.loadResource = function(mesh, req, res, next) {
    var couch = getConnection(mesh),
        targetDoc = req.url.replace(/^(.*\/)$/, '$1index');
        
    console.log('attempting to retrieve: ' + targetDoc);
        
    couch.get(targetDoc + '.html', function(error, result) {
        if (! error) {
            res.send(result);
        }
        else {
            res.send(result.reason || error, 404);
        } // if..else
    });
}; // loadResource