#!/bin/bash

message=`date +%Y-%m-%d_%H-%M`
message="run #$message"

echo $message

node index.js &&
git add . &&
git commit -a -m "$message" &&
git push