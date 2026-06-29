# Self-host deployment (budget tier)

`budget.reference.tf` is the **budget-tier** reference Terraform for hosting this
site, pulled from Drafture's own `/api/config` for the `self-hosting-a-stateful-web-app`
design — i.e. the product describing its own deployment (dogfood).

Shape: a single public **t4g.small** EC2 box with a public IP behind a security group
that only admits **Cloudflare** IP ranges (no NAT gateway, no ALB), the SQLite DB on a
**separate encrypted EBS volume** with DLM snapshot backups, CloudFront + OAC for the
static SPA assets, and the full security floor (KMS, CloudTrail, IAM instance profile,
CloudWatch logs/alarms → SNS). ~$14–42/mo.

> ⚠ **Reference only.** AI-generated starting point — read it, `terraform plan`, and set
> a billing budget before applying. You own every resource it creates.

## Required variables (no defaults)

| var | what |
|---|---|
| `vpc_id` | existing VPC to deploy into |
| `public_subnet_id` | public subnet for the EC2 instance |
| `ami_id` | ARM64 AMI (Amazon Linux 2023 / Ubuntu 22.04 arm64) for t4g.small |
| `ops_email` | address for SNS ops-alert subscription |

`aws_region` (us-east-1), `project`, and the Cloudflare IP ranges have defaults — keep
the CF ranges current (links are in the file).

## Use

```
cd deploy/self-host
terraform init
terraform plan   # review every resource
terraform apply
```

The `user_data` block bootstraps the box at a reference level; finish the app-deploy
steps (pull the container/build, mount the EBS volume for the SQLite file, wire the
`ANTHROPIC_API_KEY` via the SSM parameter) for your actual runtime.

To regenerate after a design change: open the design in the app and pull Terraform for
the budget tier again.
