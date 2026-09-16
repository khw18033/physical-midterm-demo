// Go1 라이트(HighCmd.led) 실효성 확인용 최소 테스트. 로봇은 움직이지 않는다.
// mode=0(idle) 과 mode=1(force stand) 두 경우를 모두 시도한다 — 펌웨어가 특정
// 모드에서만 led 를 읽을 가능성이 있어서다.
#include "unitree_legged_sdk/unitree_legged_sdk.h"
#include <unistd.h>
#include <cstdio>
using namespace UNITREE_LEGGED_SDK;

int main(){
  UDP udp(8091,"192.168.123.161",8082,sizeof(HighCmd),sizeof(HighState));
  HighCmd cmd={0}; udp.InitCmdData(cmd);
  struct C{const char*n;uint8_t r,g,b;};
  C seq[]={{"RED",255,0,0},{"GREEN",0,255,0},{"BLUE",0,0,255},{"OFF",0,0,0}};
  int modes[2]={0,1};
  for(int m=0;m<2;m++){
    std::printf("=== mode=%d 로 LED 시도 ===\n",modes[m]); std::fflush(stdout);
    for(int k=0;k<4;k++){
      std::printf("[LED] mode=%d %s (3s)\n",modes[m],seq[k].n); std::fflush(stdout);
      for(int i=0;i<1500;i++){
        cmd.head[0]=0xFE; cmd.head[1]=0xEF; cmd.levelFlag=HIGHLEVEL;
        cmd.mode=modes[m]; cmd.gaitType=0;
        cmd.velocity[0]=cmd.velocity[1]=cmd.yawSpeed=0;
        cmd.euler[0]=cmd.euler[1]=cmd.euler[2]=0;
        for(int j=0;j<4;j++){cmd.led[j].r=seq[k].r;cmd.led[j].g=seq[k].g;cmd.led[j].b=seq[k].b;}
        udp.SetSend(cmd); udp.Send(); usleep(2000);
      }
    }
  }
  std::printf("[LED] 끝\n"); return 0;
}
