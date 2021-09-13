# Inlets on ECS Anywhere

This is a sample AWS Cloud Development Kit architecture for deploying Inlets on ECS Anywhere.

![](/images/diagram.png)

There are three components that make up the architecture:

* *The application itself* - ECS Anywhere launches the application container onto devices that have been registered with ECS as managed instances. For simplicity of deployment we can configure ECS to deploy a single application container per host. We can use bridge networking mode and static port mappings to give each application container a port number that can be used to access the application at http://localhost:port

* *Inlets client* - This can be deployed as a ECS external type service in DAEMON mode. This will tell ECS to deploy one copy of the inlets client on each hardware device that is registered into the inlets service. We deploy this service using host networking mode so that it can communicate to the application containers on each device over the localhost loopback interface.
* *Inlets server* - This service is deployed in the cloud, using AWS Fargate capacity. This makes managing the Inlets server hands off. The Inlets service is given a public facing load balancer, which lets us assign a domain name, and handle HTTPS encryption and certificate renewal.

All three of these components can be orchestrated by Elastic Container Service. The application and the Inlets client are launched on managed instances by ECS Anywhere communicating back over the connection that the on-premises ECS Agent opened back to the ECS control plane. ECS also launches the Inlets server as a Fargate task, and orchestrates the association between the Fargate tasks and a public facing Application Load Balancer. Additionally ECS securely integrates with AWS Secrets Manger to manage the deliver of important Inlets secrets such as the Inlets license key, and the Inlets authentication token that Inlets client will use to authenticate with the Inlets server. ECS Anywhere delivers these secrets to the managed instance on-premises as well as the in-cloud AWS Fargate task.

The Application Load Balancer serves as a gateway for incoming connections from both public internet clients, and the Inlets client. The on-premises Inlets client connects to the Application Load Balancer on port 8123 and uses it’s authentication token with the Inlets server. Once the connection is established the Inlets server will add the Inlets client as an available destination for traffic. Public internet clients connect to the ALB on port 80, and their connections are sent through to the Inlets server as well. When the Inlets server receives a connection on port 80 it picks an open connection to one of the available Inlets clients, and sends the request back down to the Inlets client. Finally the Inlets client sends the request through to the Application Container on the managed instance.

Inlets supports both HTTP load balancing mode and TCP load balancing mode. In this sample architecture we are using HTTP load balancing mode to evenly distribute HTTP requests across each Inlets client, and destination application container.

If you’d like to test out this deployment you can do so right now by loading up [https://nathanpeck.gg/](https://nathanpeck.gg/) in your browser. Your connection will go to an ALB in front of an Inlets server in AWS Fargate. From there it will go back down to an Inlets client running on a Raspberry Pi on my desk. The Inlets client will then serve back a response from the local application running on my Raspberry Pi.


## Useful commands

 * `npm run build`   compile typescript to js
 * `npm run watch`   watch for changes and compile
 * `npm run test`    perform the jest unit tests
 * `cdk deploy`      deploy this stack to your default AWS account/region
 * `cdk diff`        compare deployed stack with current state
 * `cdk synth`       emits the synthesized CloudFormation template
