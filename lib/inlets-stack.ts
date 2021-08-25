import * as cdk from '@aws-cdk/core';
import * as ec2 from '@aws-cdk/aws-ec2';
import * as ecs from '@aws-cdk/aws-ecs';
import * as ecr from '@aws-cdk/aws-ecr';
import * as secretsManager from '@aws-cdk/aws-secretsmanager';
import * as elbv2 from '@aws-cdk/aws-elasticloadbalancingv2';

import * as path from 'path';
import { spawnSync } from 'child_process';

export class InletsStack extends cdk.Stack {
  constructor(scope: cdk.Construct, id: string, props?: cdk.StackProps) {
    super(scope, id, props);

    // Create an EC2 ECS cluster for hosting the Inlets exit server
    const vpc = new ec2.Vpc(this, 'vpc', { maxAzs: 2 });

    const cluster = new ecs.Cluster(this, 'cluster', { vpc });

    // Generate a secret token that will be used by Inlets clients to connect
    // to the Inlets exit server.
    var inletsToken = new secretsManager.Secret(this, 'exit-server-token', {
      generateSecretString: {
        passwordLength: 32,
        excludePunctuation: true
      }
    });

    // You will need to get your own Inlets license key and store it in Secrets Manager
    // Then substitute in your own secret's ARN here.
    var licenseKey = secretsManager.Secret.fromSecretCompleteArn(this, 'license-key', 'arn:aws:secretsmanager:us-east-2:209640446841:secret:inlets-license-key-UVnDul');

    // Launch the Inlets exit server as a service in Fargate.
    var exitServerDefinition = new ecs.FargateTaskDefinition(this, 'inlets-exit-server-task', {
      cpu: 2048,
      memoryLimitMiB: 4096,
    });

    var exitServerContainer = exitServerDefinition.addContainer('inlets', {
      image: ecs.ContainerImage.fromRegistry('ghcr.io/inlets/inlets-pro:0.9.0-rc2'),
      logging: new ecs.AwsLogDriver({ streamPrefix: 'inlets-exit-server' }),
      command: ["http", "server", "--auto-tls=false", "--token-env=INLETS_TOKEN", "--port=8000"],
      secrets: {
        INLETS_TOKEN: ecs.Secret.fromSecretsManager(inletsToken),
      },
      portMappings: [
        // This port is used for Inlets clients on each Raspberry Pi to
        // connect back to the exit server and make themselves available for traffic.
        {
          containerPort: 8123,
          hostPort: 8123
        },
        // This port is used for end users to send a request to the exit server.
        // The request then gets sent back down to one of the connected Inlets clients.
        {
          containerPort: 8000,
          hostPort: 8000
        }
      ],
    });

    exitServerContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE
    });

    var service = new ecs.FargateService(this, 'inlets-exit-server', {
      cluster,
      taskDefinition: exitServerDefinition,
      assignPublicIp: true,
      healthCheckGracePeriod: cdk.Duration.seconds(2147483647), // Effectively infinite grace period
      desiredCount: 1 // You can scale out for a more HA deployment
    });

    // Allow traffic to the exit server from anywhere. This allows my Raspberry Pi's to connect
    // from anywhere on the internet, as long as they have the secret token. It also allows end
    // users to connect to the exit server from anywhere in order to send traffic back down to my
    // Raspberry Pi's.
    service.connections.allowFromAnyIpv4(ec2.Port.tcp(8123));
    service.connections.allowFromAnyIpv4(ec2.Port.tcp(8000));

    // Launch an NLB that will sit in front of the inlet exit server, for HA and to get
    // a stable hostname for sending traffic to.
    const lb = new elbv2.NetworkLoadBalancer(this, 'inlets-lb', { vpc, internetFacing: true });
    const inletsClientListener = lb.addListener('client-listener', { port: 8123 });

    inletsClientListener.addTargets('inlets-private', {
      port: 8123,
      targets: [service.loadBalancerTarget({
        containerName: 'inlets',
        containerPort: 8123,
      })]
    });

    const inletsPublicListener = lb.addListener('public-listener', { port: 80 });

    inletsPublicListener.addTargets('inlets-public', {
      port: 80,
      targets: [service.loadBalancerTarget({
        containerName: 'inlets',
        containerPort: 8000,
      })]
    });

    // Create an ECS Anywhere service to run the Inlets clients in my Raspberry
    // Pi clusters. This is a daemon service that runs one client per Raspberry Pi.
    var clientDefinition = new ecs.ExternalTaskDefinition(this, 'client-inlets');

    var clientContainer = clientDefinition.addContainer('inlets', {
      cpu: 256,
      memoryLimitMiB: 256,
      image: ecs.ContainerImage.fromRegistry('ghcr.io/inlets/inlets-pro:0.9.0-rc2'),
      logging: new ecs.AwsLogDriver({ streamPrefix: 'inlets-client' }),
      command: [
        "http", "client", "--url=ws://" + lb.loadBalancerDnsName + ":8123", "--token-env=INLETS_TOKEN", "--upstream", "localhost:80",
        "--license-env=LICENSE_KEY"
      ],
      secrets: {
        INLETS_TOKEN: ecs.Secret.fromSecretsManager(inletsToken),
        LICENSE_KEY: ecs.Secret.fromSecretsManager(licenseKey),
      },
    });

    clientContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE
    });

    //-----------------------------------------------------------------------------------------
    // Patch necessary until the ExternalTaskDefinition properly supports
    // networking mode. :(
    var cfnDefinition = clientDefinition.node.defaultChild as ecs.CfnTaskDefinition;
    cfnDefinition.networkMode = 'host';
    //------------------------------------------------------------------------------------------

    var inletsDaemon = new ecs.ExternalService(this, 'inlets-tunnel', {
      cluster,
      taskDefinition: clientDefinition,
      desiredCount: 1,
    });

    //-PATCH-------------------------------------------------------------------------------------------
    // An override patch to turn the external service into a DAEMON. This
    // is only necessary because the CDK construct for ExternalService currently
    // does not support the `daemon` property. This patch can be removed in the future
    // when that CDK construct implementation gap has been fixed. :(
    const cfnDaemon = inletsDaemon.node.defaultChild as ecs.CfnService;
    cfnDaemon.schedulingStrategy = 'DAEMON';
    cfnDaemon.desiredCount = undefined;
    //--------------------------------------------------------------------------------------------------

    // Now define the external service that we will expose via Inlets
    // This service will run on the Raspberry Pi's in my home cluster.
    var appDefinition = new ecs.ExternalTaskDefinition(this, 'demo-app-definition');

    //-PATCH-------------------------------------------------------------------------------------------
    // Manually build and prepare the image asset. This is necessary because of missing support
    // for specifying the build platform in higher level constructs. :(
    var ecrRepo = new ecr.Repository(this, 'app-repo');

    // Manually build the image for the specified platform.
    var appImage = cdk.DockerImage.fromBuild(path.resolve('./app'), {
      platform: 'linux/arm64'
    });

    // Dump the image to a tarball in the cdk.out folder
    var absolutePath = process.cwd() + '/cdk.out/image.tar';
    console.log(absolutePath);
    const proc = spawnSync(`docker`, [
      'save',
      `--output=${absolutePath}`,
      `${appImage.image}:latest`,
    ], {
      stdio: [ // show Docker output
        'ignore', // ignore stdio
        process.stderr, // redirect stdout to stderr
        'inherit', // inherit stderr
      ],
    });

    if (proc.error) {
      throw proc.error;
    }

    if (proc.status !== 0) {
      if (proc.stdout || proc.stderr) {
        throw new Error(`[Status ${proc.status}] stdout: ${proc.stdout?.toString().trim()}\n\n\nstderr: ${proc.stderr?.toString().trim()}`);
      }
      throw new Error(`Docker save exited with status ${proc.status}`);
    }

    // Now turn the tarball into a DockerImageAsset again
    var image = ecs.ContainerImage.fromTarball(absolutePath);

    //------------------------------------------------------------------------------------------------

    var appContainer = appDefinition.addContainer('app', {
      cpu: 2048,
      memoryLimitMiB: 2048,
      image: image,
      logging: new ecs.AwsLogDriver({ streamPrefix: 'app' }),
      command: ['node', 'index.js'],
      portMappings: [
        {
          hostPort: 80,
          containerPort: 3000
        }
      ]
    });

    appContainer.addUlimits({
      softLimit: 1024000,
      hardLimit: 1024000,
      name: ecs.UlimitName.NOFILE
    });

    new ecs.ExternalService(this, 'demo-app-service', {
      cluster,
      taskDefinition: appDefinition,
      desiredCount: 4,
    });
  }
}