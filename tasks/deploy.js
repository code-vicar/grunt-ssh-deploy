 'use strict';

 module.exports = function(grunt) {

  // Please see the Grunt documentation for more information regarding task
  // creation: http://gruntjs.com/creating-tasks



  grunt.registerMultiTask('deploy', 'start deployment of the whole project', function() {
    var self = this;
    var done = self.async();
    var Connection = require('ssh2');
    var moment = require('moment');
    var timeStamp = moment().format('YYYYMMDDHHmmssSSS');
    var options = self.options();
    var maxBuffer = 800 * 1024;
    var async = require('async');


    options.servers.forEach(function(server){
      var c = new Connection();
      c.on('connect', function() {
        console.log('Connecting to server: ' + server.host);
      });
      c.on('ready', function() {
        console.log('Connected to server: ' + server.host);
        // execution of tasks
        execSingleServer(server,c);
      });
      c.on('error', function(err) {
        console.log("Error on server: " + server.host);
        console.error(err);
        if (err) {throw err;}
      });
      c.on('close', function(had_error) {
        console.log("Closed connection for server: " + server.host);
      });
      c.connect(server);
    });


    var execSingleServer = function(server, connection){
      // require local command handling
      var sys = require('sys')
      var childProcessExec = require('child_process').exec;
      var child;
      
      var execLocal = function(cmd, next) {
        var nextFun = next; 
        childProcessExec(cmd, {maxBuffer:maxBuffer}, function(err, stdout, stderr){
          grunt.log.debug(cmd); 
          grunt.log.debug('stdout: ' + stdout);
          grunt.log.debug('stderr: ' + stderr);
          if (err !== null) {
            grunt.log.errorlns('exec error: ' + err);
          }    
          nextFun(); 
        });
      };
      
      // executes a remote command via ssh
      var exec = function(cmd, showLog, next){
        connection.exec(cmd, function(err, stream) {
          if (err) console.log(err);
          stream.on('data', function(data, extended) {
            grunt.log.debug((extended === 'stderr' ? 'STDERR: ' : 'STDOUT: ') + data);
          });
          stream.on('end', function() {
            grunt.log.debug('REMOTE: ' + cmd);
            next && next()
          });
        });
      };


      // executes before tasks
      var executeBeforeTasks = function(callback){
        grunt.log.subhead('-------------------------------EXEC BEFORE DEPLOY COMMANDS');
        exec('', true, callback);
      };
      // creates folder under releases
      var createReleaseFolder = function(callback) {
        grunt.log.subhead('-------------------------------CREATE REMOTE FILES');
        var createFolder  = 'cd ' + options.deploy_path + '/releases && mkdir ' + timeStamp;
        exec(createFolder, options.debug, callback);
      };
      // zips local content with respecting exclude list
      var zipContentForDeployment = function(callback) {
        grunt.log.subhead('-------------------------------ZIPPING FOLDER');
        var excludeList = " --exclude='./deploy.tgz'";
        if (options.exclude_list) {
          options.exclude_list.map(function(item){
            excludeList += " --exclude='./" + item + "'";
          });
        }
        var command = "tar -czvf deploy.tgz ." + excludeList;
        execLocal(command, callback);
      };
      // upload zipfile to server via scp
      var uploadZipFile = function(callback) {
        grunt.log.subhead('-------------------------------UPLOAD ZIPFILE');
        var scpAuthString = server.username + "@" + server.host + ":" + options.deploy_path + "/releases/" + timeStamp + '/';
        var command = "scp ./deploy.tgz " + scpAuthString;
        execLocal(command, callback);
      };
      // unzips on remote and removes zipfolder
      var unzipOnRemote = function(callback) {
        grunt.log.subhead('-------------------------------CLEANUP REMOTE');

        var goToCurrent = "cd " + options.deploy_path + "/releases/" + timeStamp;
        var untar = "tar -xzvf deploy.tgz";
        var cleanup = "rm " + options.deploy_path + "/releases/" + timeStamp + "/deploy.tgz";
        var command = goToCurrent + " && " + untar + " && " + cleanup;
        console.log(callback)
        exec(command, options.debug, callback);
      };

      // executing commands before symlink switch
      var executeWarmupCommands = function(callback) {
        if (options.cmds_warmup) {
          grunt.log.subhead('-------------------------------EXECUTE WARMUP COMMANDS');
          var changeToDeployDir = 'cd ' + options.deploy_path + '/releases/' + timeStamp;
          var command = changeToDeployDir + ' && ' + options.cmds_warmup;
          exec(command, options.debug, callback);
        }
        else {
          callback();
        }
      };

      // changes symlink to new release folder
      var changeSymLink = function(callback) {
        grunt.log.subhead('-------------------------------SWITCH SYMLINK');

        var removeCurrent = 'rm -rf ' + options.deploy_path + '/current';
        var setCurrent    = 'ln -s ' + options.deploy_path + '/releases/' + timeStamp + ' ' + options.deploy_path + '/current';
        var command = removeCurrent + " && " + setCurrent;
        exec(command, options.debug, callback);
      };

      // removing local zipfile
      var localCleanup = function(callback) {
        grunt.log.subhead('-------------------------------CLEANUP LOCAL');
        var command = 'rm deploy.tgz';
        execLocal(command, callback);
      };
      
      // executing post commands on remote machine
      var executePostCommands = function(callback) {
        if (options.cmds_after_deploy) {
          grunt.log.subhead('-------------------------------EXECUTE POSTDEPLOY COMMANDS');
          var changeToDeployDir = 'cd ' + options.deploy_path + '/releases/' + timeStamp;
          var command = changeToDeployDir + ' && ' + options.cmds_after_deploy;
          exec(command, options.debug, callback);
        }
        else {
          callback();
        }
      };

      // updating forever upstart symlink
      var changeUpstartSymlink = function(callback) {
        //only run this if given 'upstart' options
        if (options.upstart && options.upstart.file_path && options.upstart.file_name) {
          grunt.log.subhead('-------------------------------INIT UPSTART SCRIPT');

          var appname = options.upstart.file_name.substr(0, options.upstart.file_name.lastIndexOf('.')) || options.upstart.file_name;
          var sudoExec = 'echo ' + server.sudopassword + ' | sudo -S ';
          var stopUpstart = sudoExec + 'stop ' + appname;
          var copyUpstart = sudoExec + 'cp -f ' + options.upstart.file_path + '/' + options.upstart.file_name + ' ' + '/etc/init/' + options.upstart.file_name;
          var startUpstart = sudoExec + 'start ' + appname;
          if (options.upstart.cold && options.upstart.cold===true) {
            var command = copyUpstart + " && " + startUpstart;
          } else {
            var command = stopUpstart + " && " + copyUpstart + " && " + startUpstart;
          }
          
          exec(command, options.debug, callback);
        } else {
          callback();
        }
      };

      // start/restart application scripts
      var startApplication = function(callback) {
        //only run this if given 'app_start' options
        if (options.app_start && options.app_start.node_exec && options.app_start.file_path && options.app_start.file_name) {
          grunt.log.subhead('-------------------------------START APPLICATION');

          var full_script_path = options.app_start.file_path + '/' + options.app_start.file_name;
          var command = options.app_start.node_exec + ' ' + full_script_path;
          exec(command, options.debug, callback);
        } else {
          callback();
        }
      };

      // updating nginx symlink
      var changeNginxConfSymlink = function(callback) {
        //only run this if given 'nginx' options
        if (options.nginx && options.nginx.file_path && options.nginx.file_name) {
          grunt.log.subhead('-------------------------------UPDATE NGINX SITES_ENABLED SYMLINK');
          
          var command = 'echo ' + server.sudopassword + ' | sudo -S ln -nfs ' + options.nginx.file_path + '/' + options.nginx.file_name + ' ' + '/etc/nginx/sites-enabled/' + options.nginx.file_name;
          exec(command, options.debug, callback);
        } else {
          callback();
        }
      };

      // closing connection to remote server
      var closeConnection = function(callback) {
        connection.end();
      };






      /*---------------------------------------
       *
       * async execution of the deploy steps
       *
       ---------------------------------------*/
      async.series([
        executeBeforeTasks, 
        createReleaseFolder, 
        zipContentForDeployment,
        uploadZipFile,
        unzipOnRemote,
        executeWarmupCommands,
        changeSymLink,
        localCleanup,
        executePostCommands,
        changeUpstartSymlink,
        startApplication,
        changeNginxConfSymlink,
        closeConnection
      ]);
    };
  });
};
