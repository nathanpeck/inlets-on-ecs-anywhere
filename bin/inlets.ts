#!/usr/bin/env node
import 'source-map-support/register';
import * as cdk from '@aws-cdk/core';
import { InletsStack } from '../lib/inlets-stack';

const app = new cdk.App();
var stack = new InletsStack(app, 'InletsStack', {});
