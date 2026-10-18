# OpenFrame softphone panel

OpenFrame puts the Vobiz softphone in the ServiceNow Next Experience header.
It needs the **OpenFrame** plugin (`com.sn_openframe`) and a backend reachable
over HTTPS.

## Create the configuration

1. Go to **OpenFrame → Configurations** and click **New**.
2. Fill in:

   | Field | Value |
   | --- | --- |
   | Name | `Vobiz Softphone` |
   | Title | `Vobiz Calling` |
   | URL | `https://calling.example.com/agent-phone.html?instance=your-instance&agentId=<ServiceNow user name>` |
   | Width | `380` |
   | Height | `560` |
   | User group | The agents who should see the panel |
   | Active | checked |

3. Click **Submit**.

`instance` is the `your-instance` part of `your-instance.service-now.com`. The
softphone loads the OpenFrame API from that instance; without it, it uses the
host of the page that framed it.

`agentId` should be the agent's ServiceNow user name. It decides which SIP
endpoint the agent gets, lets **Call via Vobiz** find the agent's panel, and
assigns logged calls to the agent. Every agent needs their own value. Because a
configuration has one URL for its whole user group, create one configuration
per agent, or have agents open the softphone URL in a browser tab. See
[Agent identity](../../README.md#agent-identity) in the README.

## What agents see

- The panel opens from the phone icon in the header and shows the softphone.
- It opens by itself when a call comes in.
- **Call via Vobiz** on a record hands the number to the open, signed-in panel,
  which dials it.
- If the browser blocks the microphone inside the frame, open the same URL in
  its own tab; calling and **Call via Vobiz** work the same way there.
